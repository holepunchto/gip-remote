const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Hyperbee = require('hyperbee2')
const ScopeLock = require('scope-lock')
const z32 = require('z32')
const def = require('./schema/hyperdb/index')
const RemoteDrive = require('./lib/drive')
const GitPearLink = require('./lib/link')
const { parseCommit, parseTag, walkTree, objectLinks } = require('./lib/git')
const { getObject, putObject } = require('./lib/objects')
const { TreeDrive } = RemoteDrive

const BATCH = 256

class Remote extends ReadyResource {
  _db = null
  _link = null
  _name = null
  _timeout = 0
  _writeLock = new ScopeLock()
  // Oids confirmed present this session — objects are append-only, so a
  // confirmation never goes stale. Saves re-checking the shared thin set on
  // every ref of a multi-ref push (git push --tags is one push() per tag).
  _storedOids = new Set()
  // The branch this session made the head by default. While it stands, a
  // push of main (else master) takes the head over from it.
  _autoHead = null
  // Ref tips by oid, rebuilt when the db moves: { length, tips }
  _tipIndex = null

  constructor(store, link, opts = {}) {
    super()

    this._link =
      typeof link === 'string' && link.startsWith('git+pear:') ? GitPearLink.parse(link) : link

    let config
    if (typeof this._link === 'string') {
      this._name = this._link
      config = { core: store.get({ name: this._link }), autoUpdate: true }
    } else if (this._link.drive) {
      this._name = this._link.pathname?.split('/').slice(1)[0]
      config = { key: this._link.drive.key, autoUpdate: true }
    } else {
      this._name = this._link.name
      config = { ...this._link, autoUpdate: true }
    }

    const bee = new Hyperbee(store, config)
    this._db = HyperDB.bee2(bee, def, { autoUpdate: true })

    this._timeout = opts.timeout || 240_000
  }

  async _open() {
    await this._db.ready()
  }

  async _close() {
    await this._db.close()
  }

  // Serialize mutations. push() does a read-modify-write of a branch's
  // denormalized object set, so concurrent writers must not interleave.
  async _locked(fn) {
    await this._writeLock.lock()
    try {
      return await fn()
    } finally {
      this._writeLock.unlock()
    }
  }

  // Run `fn` against a writable snapshot, serialized behind the write lock.
  // Readers of the main instance never see partial state — everything lands
  // on flush, nothing on error.
  // `landed` runs once the write is durable, still behind the lock.
  async _transaction(fn, landed) {
    return this._locked(async () => {
      const tx = this._db.transaction()
      let result
      try {
        result = await fn(tx)
        await tx.flush()
      } catch (err) {
        tx.close()
        throw err
      }
      if (landed) landed(result)
      return result
    })
  }

  get name() {
    return this._name
  }

  get core() {
    return this._db.core
  }

  get key() {
    return this._db.core.key
  }

  get discoveryKey() {
    return this._db.core.discoveryKey
  }

  get availablePeers() {
    return this._db.core.peers.length
  }

  get url() {
    const head = this._db.db.head()
    return `git+pear://0.${head.length}.${z32.encode(head.key)}/${this.name}`
  }

  // --- Objects ---

  async getObject(oid) {
    return getObject(this._db, oid)
  }

  // --- Refs / Branches ---

  async getHead() {
    const record = await this._db.get('@gip/head', {})
    return record ? record.branch : null
  }

  async setHead(branch) {
    return this._transaction(
      (tx) => tx.insert('@gip/head', { branch }),
      () => (this._autoHead = null)
    )
  }

  async getAllRefs() {
    const refs = []

    const branches = this._db.find('@gip/branches')
    for await (const b of branches) {
      refs.push({ ref: `refs/heads/${b.name}`, oid: b.commitOid })
    }

    const tags = this._db.find('@gip/tags')
    for await (const t of tags) {
      const ref = { ref: `refs/tags/${t.name}`, oid: t.oid }
      if (t.commitOid !== t.oid) ref.peeled = t.commitOid
      refs.push(ref)
    }

    const headBranch = await this.getHead()
    if (headBranch) {
      const head = refs.find((r) => r.ref === `refs/heads/${headBranch}`)
      if (head) refs.push({ ref: 'HEAD', symref: head.ref, oid: head.oid })
    }

    return refs.reverse()
  }

  async getBranchRef(branch) {
    const b = await this._db.get('@gip/branches', { name: branch })
    if (!b) return null
    return { ref: `refs/heads/${b.name}`, oid: b.commitOid }
  }

  async deleteBranch(branchName) {
    return this._transaction((tx) => this._deleteBranch(tx, branchName))
  }

  async _deleteBranch(tx, branchName) {
    const branch = await tx.get('@gip/branches', { name: branchName })
    if (!branch) return false

    await tx.delete('@gip/branches', { name: branchName })

    // Remove file records for this branch
    const files = tx.find('@gip/files', {
      gte: { branch: branchName },
      lte: { branch: branchName }
    })
    for await (const file of files) {
      await tx.delete('@gip/files', { branch: branchName, path: file.path })
      await tx.delete('@gip/file-commits', { branch: branchName, path: file.path })
    }

    return true
  }

  async deleteTag(tagName) {
    return this._transaction((tx) => this._deleteTag(tx, tagName))
  }

  async _deleteTag(tx, tagName) {
    const tag = await tx.get('@gip/tags', { name: tagName })
    if (!tag) return false

    await tx.delete('@gip/tags', { name: tagName })

    // Tags pushed by older versions were file-indexed as the branch
    // `tags/<name>`. A real branch of that name owns those rows.
    const filesBranch = 'tags/' + tagName
    if (await tx.get('@gip/branches', { name: filesBranch })) return true

    const files = tx.find('@gip/files', {
      gte: { branch: filesBranch },
      lte: { branch: filesBranch }
    })
    for await (const file of files) {
      await tx.delete('@gip/files', { branch: filesBranch, path: file.path })
      await tx.delete('@gip/file-commits', { branch: filesBranch, path: file.path })
    }

    return true
  }

  // Delete `refs/heads/<name>` or `refs/tags/<name>`. `opts.expect` as in
  // pushRef. The head branch can't be deleted this way (DELETE_HEAD).
  async deleteRef(ref, opts = {}) {
    const target = parseRef(ref)

    return this._transaction(async (tx) => {
      await this._expect(tx, target, opts.expect)
      if (target.tag) return this._deleteTag(tx, target.name)

      const head = await tx.get('@gip/head', {})
      if (head && head.branch === target.name && (await this._tip(tx, target)) !== null) {
        throw error('DELETE_HEAD', 'Refusing to delete the head branch: ' + ref)
      }
      return this._deleteBranch(tx, target.name)
    })
  }

  async _tip(tx, target) {
    if (target.tag) {
      const tag = await tx.get('@gip/tags', { name: target.name })
      return tag ? tag.oid : null
    }
    const branch = await tx.get('@gip/branches', { name: target.name })
    return branch ? branch.commitOid : null
  }

  // expect: undefined = no check, null = the ref must not exist, an oid = the
  // ref must be at it. Runs inside the transaction that then writes the ref.
  async _expect(tx, target, expect) {
    if (expect === undefined) return
    const tip = await this._tip(tx, target)
    if (tip !== expect) {
      throw error('STALE_REF', `Stale ref: expected ${expect}, found ${tip}`, {
        expected: expect,
        actual: tip
      })
    }
  }

  // --- Push: store objects + index branch/tag + files ---

  // `name` is a branch name, or `tags/<name>` for a tag.
  async push(name, oid, objects, opts) {
    const ref = name.startsWith('tags/') ? 'refs/' + name : 'refs/heads/' + name
    return this.pushRef(ref, oid, objects, opts)
  }

  // Point `ref` (`refs/heads/<name>` or `refs/tags/<name>`) at `oid`.
  //
  // `objects` is a Map of oid → { type, size, data }, or an iterable or async
  // iterable of { oid, type, size, data }. It may be a thin set — just the
  // objects the remote doesn't have yet. Anything else needed for indexing
  // (the tip on a no-op push, unchanged sub-trees) is pulled from the store
  // on demand. Whatever a new object links to must be in the set or in the
  // store, or the push is rejected (MISSING_OBJECTS).
  async pushRef(ref, oid, objects, opts = {}) {
    const target = parseRef(ref)
    const stored = []

    await this._transaction(
      (tx) => this._push(tx, target, oid, objects, opts, stored),
      (head) => {
        for (const o of stored) this._storedOids.add(o)
        if (head) this._autoHead = head
      }
    )
  }

  // Look an object up in the pushed set first, then in the store — thin
  // pushes reference objects that arrived in an earlier push.
  async _resolveObject(tx, objects, oid) {
    const obj = objects.get(oid)
    if (obj) return obj
    const stored = await getObject(tx, oid)
    if (stored) objects.resolved.set(oid, stored)
    return stored
  }

  // Store what the remote doesn't have yet, and return the pushed set as a
  // lookup. An iterable is consumed as it comes: blobs go straight to the
  // store and only their size is kept.
  async _store(tx, source, stored) {
    const pushed = source instanceof Map ? source : new Map()
    const resolved = new Map()
    const fresh = new Set()
    const links = new Set()

    // The presence check is cheap (the stub row exists for chunked objects
    // too) and runs in batches instead of one awaited round-trip per object.
    const put = async (batch) => {
      const existing = await Promise.all(batch.map(([oid]) => this._has(tx, oid)))
      for (let i = 0; i < batch.length; i++) {
        const [oid, obj] = batch[i]
        stored.push(oid)
        if (existing[i]) continue
        await putObject(tx, oid, obj)
        fresh.add(oid)
        for (const link of objectLinks(obj)) links.add(link)
      }
    }

    const batch = []
    if (source instanceof Map) {
      for (const entry of source) {
        if (batch.push(entry) === BATCH) await put(batch.splice(0))
      }
    } else {
      for await (const obj of source) {
        pushed.set(obj.oid, obj.type === 'blob' ? { type: obj.type, size: obj.size } : obj)
        if (batch.push([obj.oid, obj]) === BATCH) await put(batch.splice(0))
      }
    }
    await put(batch)

    // Connectivity: every object stored so far has its links in the store,
    // so only the new ones need checking, and only one level deep.
    const boundary = []
    for (const oid of links) if (!fresh.has(oid)) boundary.push(oid)
    const missing = []
    for (let i = 0; i < boundary.length; i += BATCH) {
      const slice = boundary.slice(i, i + BATCH)
      const existing = await Promise.all(slice.map((oid) => this._has(tx, oid)))
      for (let j = 0; j < slice.length; j++) if (!existing[j]) missing.push(slice[j])
    }
    if (missing.length > 0) throw missingObjects(missing)

    return { resolved, get: (oid) => pushed.get(oid) ?? resolved.get(oid) }
  }

  async _has(tx, oid) {
    return this._storedOids.has(oid) || (await tx.get('@gip/objects', { oid })) !== null
  }

  async _push(tx, target, oid, source, opts, stored) {
    await this._expect(tx, target, opts.expect)

    // 1. Store all git objects the remote doesn't already have.
    const objects = await this._store(tx, source, stored)

    // 2. Dereference tag objects to find what the ref peels to
    let resolvedOid = oid
    let obj = await this._resolveObject(tx, objects, resolvedOid)
    if (!obj) throw missingObjects([resolvedOid])

    let tagMeta = null
    while (obj.type === 'tag') {
      const tag = parseTag(obj.data)
      if (!tagMeta) tagMeta = tag
      if (!tag.object) throw new Error('Tag has no object: ' + resolvedOid)
      resolvedOid = tag.object
      obj = await this._resolveObject(tx, objects, resolvedOid)
      if (!obj) throw missingObjects([resolvedOid])
    }

    const commit = obj.type === 'commit' ? parseCommit(obj.data) : null
    if (commit && !commit.tree) throw new Error('Commit has no tree: ' + resolvedOid)

    // Tags stop here: no denormalized object list (getRefObjects walks the
    // graph) and no file index — their trees are immutable and toDrive
    // serves them lazily from the tree objects. Indexing every tag's full
    // tree made pushing a release history O(tags × files). A tag may point
    // at any object; one that isn't a commit has no tree, and no drive view.
    if (target.tag) {
      await tx.insert('@gip/tags', {
        name: target.name,
        oid,
        commitOid: resolvedOid,
        treeOid: commit ? commit.tree : '',
        tagger: tagMeta ? tagMeta.tagger : null,
        message: tagMeta ? tagMeta.message : null,
        timestamp: tagMeta ? tagMeta.timestamp : 0,
        objects: []
      })
      return
    }

    if (!commit) {
      throw new Error('Expected commit, got ' + obj.type + ': ' + resolvedOid)
    }

    const refName = target.name

    // 3. Walk tree to enumerate files. A thin push doesn't re-send unchanged
    // sub-trees, so pull whatever the walk couldn't expand from the store
    // and re-walk until the tree is complete.
    let files
    for (;;) {
      const missing = []
      files = walkTree(objects, commit.tree, '', missing)
      if (missing.length === 0) break
      let resolved = 0
      for (const treeOid of missing) {
        if (await this._resolveObject(tx, objects, treeOid)) resolved++
      }
      if (resolved === 0) break // genuinely absent — index what we can see
    }

    // 4a. Reconcile deletions — remove file records whose paths no longer
    //     exist in the new tree. Without this, files removed in a commit
    //     would persist in the index forever (only `deleteBranch` cleans
    //     them up, and only on full branch deletion). The drive view would
    //     keep showing ghost files; consumers iterating @gip/files would
    //     emit stale entries.
    //
    //     We rebuild the new path set first, then sweep the existing
    //     records — O(N) in the size of the indexed tree, same order as
    //     the insert step that follows.
    const newPaths = new Set(files.map((f) => f.path))
    const existingFiles = tx.find('@gip/files', {
      gte: { branch: refName },
      lte: { branch: refName }
    })
    for await (const file of existingFiles) {
      if (!newPaths.has(file.path)) {
        await tx.delete('@gip/files', { branch: refName, path: file.path })
        await tx.delete('@gip/file-commits', { branch: refName, path: file.path })
      }
    }

    // 4b. Compute, for each file in HEAD's tree, the most recent commit IN
    //     THIS PUSH that actually changed its blob — that's the commit we
    //     want to credit on the @gip/files row. If we just stamped every
    //     file with HEAD's metadata (the previous behaviour), a fresh push
    //     of a multi-commit history would make every file look like it was
    //     last edited by HEAD, which is useless for a tree view.
    //
    //     Algorithm: walk the commit chain HEAD → first-parent through the
    //     commits we have in the pack, flatten each commit's tree into a
    //     path → oid map, and for each path record the most recent commit
    //     whose tree differs at that path from its first-parent's tree.
    //     We don't follow merge parents — same heuristic GitHub's "blame"
    //     uses; it keeps cost predictable and matches user expectation.
    //
    //     Cases the fallback below handles:
    //       - Pack is shallow and the path was already at HEAD's blob
    //         before our oldest commit — keep the existing row as-is.
    //       - First push containing a root commit — files appearing in the
    //         root take the root commit's metadata.
    const fileLastTouch = computeFileLastTouch(objects, resolvedOid, commit)
    const oldestInPack = fileLastTouch.oldest

    for (const file of files) {
      const existing = await tx.get('@gip/files', {
        branch: refName,
        path: file.path
      })

      let meta = fileLastTouch.byPath.get(file.path)

      if (!meta) {
        // No commit in our pack changed this file. Either it's been at this
        // blob since before our window, or the pack is shallow.
        if (existing && existing.oid === file.oid && existing.mode === file.mode) {
          // Genuinely unchanged from prior push — leave row alone.
          continue
        }
        // Fall back to the oldest commit we have. Best approximation when a
        // shallow clone is being seeded (we don't have the real introducing
        // commit, but the oldest commit in the pack is a strict upper bound
        // on "when it could have last changed" given what we know).
        meta = {
          author: oldestInPack.author,
          message: oldestInPack.message,
          timestamp: oldestInPack.timestamp,
          commitOid: oldestInPack.oid
        }
      }

      // Idempotency: if the existing row already reflects the same blob,
      // mode, and metadata we'd write, skip the insert. Saves a write
      // round-trip on no-op pushes (e.g. retries). The attribution row is
      // still written when absent so rows from before it existed backfill.
      if (
        existing &&
        existing.oid === file.oid &&
        existing.mode === file.mode &&
        existing.message === meta.message &&
        existing.timestamp === meta.timestamp
      ) {
        const attributed = await tx.get('@gip/file-commits', {
          branch: refName,
          path: file.path
        })
        if (!attributed) {
          await tx.insert('@gip/file-commits', {
            branch: refName,
            path: file.path,
            commitOid: meta.commitOid
          })
        }
        continue
      }

      // A thin push doesn't carry blobs the remote has: their size is in
      // the store. Submodule commits are in neither.
      let size = file.size
      if (file.mode !== '160000' && !objects.get(file.oid)) {
        const blob = await tx.get('@gip/objects', { oid: file.oid })
        if (blob) size = blob.size
      }

      await tx.insert('@gip/files', {
        branch: refName,
        path: file.path,
        oid: file.oid,
        mode: file.mode,
        size,
        author: meta.author,
        message: meta.message,
        timestamp: meta.timestamp
      })
      await tx.insert('@gip/file-commits', {
        branch: refName,
        path: file.path,
        commitOid: meta.commitOid
      })
    }

    // 5. Insert/update the branch record. No denormalized object list —
    // getRefObjects walks the graph from the tip, so the record only carries
    // the tip metadata. (Records written by older versions still hold their
    // lists; the walk is the fallback-free path for empty ones.)
    await tx.insert('@gip/branches', {
      name: refName,
      commitOid: oid,
      treeOid: commit.tree,
      author: commit.author,
      message: commit.message,
      timestamp: commit.timestamp,
      objects: []
    })

    // 6. Default the head: the first branch pushed, until main (else master)
    // arrives in the same session. A head set with setHead is never moved.
    const head = await tx.get('@gip/head', {})
    const takesOver =
      head && head.branch === this._autoHead && headRank(refName) < headRank(head.branch)
    if (head && !takesOver) return

    await tx.insert('@gip/head', { branch: refName })
    return refName
  }

  // Ref tips by oid, so a fetch of many refs doesn't scan them per ref. The
  // scans always run to the end: destroying a hyperdb stream early kills the
  // requests of every other read on the db.
  async _tips() {
    const length = this._db.core.length
    if (this._tipIndex && this._tipIndex.length === length) return this._tipIndex.tips

    const tips = new Map()
    for await (const t of this._db.find('@gip/tags')) {
      tips.set(t.oid, { collection: '@gip/tags', name: t.name, legacy: t.objects.length > 0 })
    }
    for await (const b of this._db.find('@gip/branches')) {
      tips.set(b.commitOid, {
        collection: '@gip/branches',
        name: b.name,
        legacy: b.objects.length > 0
      })
    }

    this._tipIndex = { length, tips }
    return tips
  }

  // --- Fetch support ---

  // opts.seen — a Set shared across calls so a multi-ref fetch (a clone
  // pulls every branch and tag) walks shared history once; objects already
  // seen are omitted from the result, the caller has them.
  async getRefObjects(oid, onLoad, opts = {}) {
    const tip = (await this._tips()).get(oid)
    if (!tip) return []

    // Only records written by older versions need reading in full
    const record = tip.legacy ? await this._db.get(tip.collection, { name: tip.name }) : null

    const seen = opts.seen ?? new Set()

    // Records written by older versions carry the denormalized reachable
    // set — serve it directly.
    if (record && record.objects.length > 0) {
      const results = []
      for (const objOid of record.objects) {
        if (seen.has(objOid)) continue
        seen.add(objOid)

        const obj = await this.getObject(objOid)
        if (!obj) continue

        // Empty blobs have null data after round-tripping through compact-encoding
        const data = obj.data || Buffer.alloc(0)

        if (onLoad) onLoad(obj.size)
        results.push({ ...obj, data, id: objOid })
      }
      return results
    }

    // Walk the object graph from the tip — pushes guarantee every reachable
    // object is in the store, so traversal replaces the stored list. Missing
    // parents just bound the walk (shallow-seeded repos).
    const results = []
    const stack = [oid]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)

      const obj = await this.getObject(cur)
      if (!obj) continue

      const data = obj.data || Buffer.alloc(0)
      if (onLoad) onLoad(obj.size)
      results.push({ ...obj, data, id: cur })

      if (obj.type === 'tag') {
        const tag = parseTag(data)
        if (tag.object) stack.push(tag.object)
      } else {
        for (const link of objectLinks({ type: obj.type, data })) stack.push(link)
      }
    }

    return results
  }

  // --- Drive ---

  // `name` is a full ref name (`refs/heads/x`, `refs/tags/x`), or a bare
  // name: the branch of that name, else the tag. Null when there is no such
  // ref, or it is a tag of something that isn't a commit.
  async toDrive(name) {
    if (name.startsWith('refs/heads/')) return this._branchDrive(name.slice(11))
    if (name.startsWith('refs/tags/')) return this._tagDrive(name.slice(10))

    return (
      (await this._branchDrive(name)) ||
      (await this._tagDrive(name)) ||
      (name.startsWith('tags/') ? this._tagDrive(name.slice(5)) : null)
    )
  }

  async _branchDrive(branch) {
    if (!(await this._db.get('@gip/branches', { name: branch }))) return null
    const drive = new RemoteDrive(this._db, { branch })
    await drive.ready()
    return drive
  }

  // Tags aren't file-indexed — serve the immutable tree lazily from the
  // tree objects instead.
  async _tagDrive(name) {
    const tag = await this._db.get('@gip/tags', { name })
    if (!tag || !tag.treeOid) return null
    const drive = new TreeDrive(this._db, { treeOid: tag.treeOid })
    await drive.ready()
    return drive
  }

  // --- Peer discovery ---

  async update() {
    await this._db.update()
  }

  async waitForPeers() {
    await this.ready()

    if (this.availablePeers === 0) {
      const core = this._db.core
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          core.removeListener('peer-add', onPeer)
          this.removeListener('close', onClose)
        }
        const onPeer = () => {
          cleanup()
          resolve()
        }
        const onClose = () => {
          cleanup()
          reject(new Error('Remote closed while waiting for peers'))
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`Timeout waiting for peers after ${this._timeout}ms`))
        }, this._timeout)

        core.on('peer-add', onPeer)
        this.once('close', onClose)
      })
    }

    await this._db.update()
  }
}

function error(code, message, props) {
  const err = new Error(message)
  err.code = code
  return Object.assign(err, props)
}

function missingObjects(missing) {
  const more = missing.length > 3 ? ` and ${missing.length - 3} more` : ''
  return error('MISSING_OBJECTS', `Missing objects: ${missing.slice(0, 3).join(', ')}${more}`, {
    missing
  })
}

function parseRef(ref) {
  if (ref.startsWith('refs/heads/') && ref.length > 11) return { tag: false, name: ref.slice(11) }
  if (ref.startsWith('refs/tags/') && ref.length > 10) return { tag: true, name: ref.slice(10) }
  throw error('UNSUPPORTED_REF', 'Unsupported ref namespace: ' + ref)
}

function headRank(branch) {
  return branch === 'main' ? 0 : branch === 'master' ? 1 : 2
}

/**
 * Walk the first-parent commit chain (within `objects`) starting at HEAD,
 * and for each path in HEAD's tree return the metadata of the most recent
 * commit whose tree differs at that path from its parent's tree.
 *
 * Returns:
 *   - byPath:  Map<path, { author, message, timestamp, commitOid }> for
 *              paths we could attribute within the pack.
 *   - oldest:  the oldest commit reached, with its `oid` (used as a
 *              fallback by callers when the pack is shallow and a path was
 *              already at its current blob before the pack window).
 *
 * Pure function — does no IO, just inspects the in-memory `objects` map.
 */
function computeFileLastTouch(objects, headOid, headCommit) {
  // 1. Walk the chain through first-parent edges, stopping at the first
  //    parent we don't have. Stash both the parsed commit and the OID.
  const chain = []
  let curOid = headOid
  let cur = headCommit
  for (;;) {
    chain.push({ oid: curOid, commit: cur })
    if (!cur.parents || cur.parents.length === 0) break
    const parentOid = cur.parents[0]
    const parentObj = objects.get(parentOid)
    if (!parentObj || parentObj.type !== 'commit') break
    cur = parseCommit(parentObj.data)
    curOid = parentOid
  }

  // 2. Flatten each commit's tree into a path → oid map. walkTree handles
  //    nested trees and skips missing sub-trees gracefully (returns []),
  //    which is what we want for incremental packs that don't re-send
  //    unchanged sub-trees.
  const treeMaps = chain.map(({ commit }) => {
    const map = new Map()
    for (const f of walkTree(objects, commit.tree, '')) {
      map.set(f.path, f.oid)
    }
    return map
  })

  // 3. Walk newest-first; record the change point for each HEAD path.
  const byPath = new Map()
  const remaining = new Set(treeMaps[0].keys())

  for (let i = 0; i < chain.length && remaining.size > 0; i++) {
    const cur = treeMaps[i]
    const isLast = i === chain.length - 1
    const par = isLast ? null : treeMaps[i + 1]
    // True root commit (no parents at all) — files appearing here are new,
    // so they're attributed to this commit. We must NOT do the same when
    // we ran out of pack (parents exist, just not in pack), or we'd make
    // up an attribution that isn't real.
    const isRoot = isLast && (!chain[i].commit.parents || chain[i].commit.parents.length === 0)

    for (const path of remaining) {
      const curOidAtPath = cur.get(path)
      if (curOidAtPath === undefined) continue

      if (par) {
        const parOidAtPath = par.get(path)
        if (parOidAtPath !== curOidAtPath) {
          byPath.set(path, {
            author: chain[i].commit.author,
            message: chain[i].commit.message,
            timestamp: chain[i].commit.timestamp,
            commitOid: chain[i].oid
          })
          remaining.delete(path)
        }
      } else if (isRoot) {
        byPath.set(path, {
          author: chain[i].commit.author,
          message: chain[i].commit.message,
          timestamp: chain[i].commit.timestamp,
          commitOid: chain[i].oid
        })
        remaining.delete(path)
      }
      // else: shallow boundary — caller falls back to existing row /
      // oldest-commit metadata.
    }
  }

  return {
    byPath,
    oldest: {
      ...chain[chain.length - 1].commit,
      oid: chain[chain.length - 1].oid
    }
  }
}

module.exports = {
  Remote,
  RemoteDrive,
  GitPearLink,
  parseCommit,
  walkTree
}
