const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Hyperbee = require('hyperbee2')
const ScopeLock = require('scope-lock')
const z32 = require('z32')
const def = require('./schema/hyperdb/index')
const RemoteDrive = require('./lib/drive')
const GitPearLink = require('./lib/link')
const { parseCommit, parseTag, walkTree, treeEntries } = require('./lib/git')
const { getObject, putObject } = require('./lib/objects')
const { TreeDrive } = RemoteDrive

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
    return this._locked(async () => {
      await this._db.insert('@gip/head', { branch })
      await this._db.flush()
    })
  }

  async getAllRefs() {
    const refs = []

    const branches = this._db.find('@gip/branches')
    for await (const b of branches) {
      refs.push({ ref: `refs/heads/${b.name}`, oid: b.commitOid })
    }

    const tags = this._db.find('@gip/tags')
    for await (const t of tags) {
      refs.push({ ref: `refs/tags/${t.name}`, oid: t.oid })
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
    return this._locked(() => this._deleteBranch(branchName))
  }

  async _deleteBranch(branchName) {
    const branch = await this._db.get('@gip/branches', { name: branchName })
    if (!branch) return false

    await this._db.delete('@gip/branches', { name: branchName })

    // Remove file records for this branch
    const files = this._db.find('@gip/files', {
      gte: { branch: branchName },
      lte: { branch: branchName }
    })
    for await (const file of files) {
      await this._db.delete('@gip/files', { branch: branchName, path: file.path })
    }

    await this._db.flush()
    return true
  }

  async deleteTag(tagName) {
    return this._locked(() => this._deleteTag(tagName))
  }

  async _deleteTag(tagName) {
    const tag = await this._db.get('@gip/tags', { name: tagName })
    if (!tag) return false

    await this._db.delete('@gip/tags', { name: tagName })

    // Remove file records for this tag
    const filesBranch = 'tags/' + tagName
    const files = this._db.find('@gip/files', {
      gte: { branch: filesBranch },
      lte: { branch: filesBranch }
    })
    for await (const file of files) {
      await this._db.delete('@gip/files', { branch: filesBranch, path: file.path })
    }

    await this._db.flush()
    return true
  }

  // --- Push: store objects + index branch/tag + files ---

  // `objects` may be a thin set — just the objects the remote doesn't have
  // yet. Anything else needed for indexing (the tip on a no-op push,
  // unchanged sub-trees) is pulled from the store on demand.
  async push(refName, oid, objects) {
    return this._locked(() => this._push(refName, oid, objects))
  }

  // Look an object up in the pushed set first, then in the store — thin
  // pushes reference objects that arrived in an earlier push.
  async _resolveObject(objects, oid) {
    const obj = objects.get(oid)
    if (obj) return obj
    const stored = await getObject(this._db, oid)
    if (stored) objects.set(oid, stored)
    return stored
  }

  async _push(refName, oid, objects) {
    // 1. Store all git objects the remote doesn't already have. The presence
    // check is cheap (the stub row exists for chunked objects too) and runs
    // in batches instead of one awaited round-trip per object.
    const oids = [...objects.keys()].filter((objOid) => !this._storedOids.has(objOid))
    for (let i = 0; i < oids.length; i += 256) {
      const batch = oids.slice(i, i + 256)
      const existing = await Promise.all(
        batch.map((objOid) => this._db.get('@gip/objects', { oid: objOid }))
      )
      for (let j = 0; j < batch.length; j++) {
        if (!existing[j]) await putObject(this._db, batch[j], objects.get(batch[j]))
        this._storedOids.add(batch[j])
      }
    }

    // 2. Dereference tag objects to find the commit
    let resolvedOid = oid
    let obj = await this._resolveObject(objects, resolvedOid)
    if (!obj) throw new Error('Object not found: ' + resolvedOid)

    let tagMeta = null
    while (obj.type === 'tag') {
      const tag = parseTag(obj.data)
      if (!tagMeta) tagMeta = tag
      if (!tag.object) throw new Error('Tag has no object: ' + resolvedOid)
      resolvedOid = tag.object
      obj = await this._resolveObject(objects, resolvedOid)
      if (!obj) throw new Error('Object not found: ' + resolvedOid)
    }

    if (obj.type !== 'commit') {
      throw new Error('Expected commit, got ' + obj.type + ': ' + resolvedOid)
    }

    const commit = parseCommit(obj.data)
    if (!commit.tree) throw new Error('Commit has no tree: ' + resolvedOid)

    // Tags stop here: no denormalized object list (getRefObjects walks the
    // graph) and no file index — their trees are immutable and toDrive
    // serves them lazily from the tree objects. Indexing every tag's full
    // tree made pushing a release history O(tags × files).
    if (refName.startsWith('tags/')) {
      await this._db.insert('@gip/tags', {
        name: refName.slice(5),
        oid,
        commitOid: resolvedOid,
        treeOid: commit.tree,
        tagger: tagMeta ? tagMeta.tagger : null,
        message: tagMeta ? tagMeta.message : null,
        timestamp: tagMeta ? tagMeta.timestamp : 0,
        objects: []
      })
      await this._db.flush()
      return
    }

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
        if (await this._resolveObject(objects, treeOid)) resolved++
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
    const existingFiles = this._db.find('@gip/files', {
      gte: { branch: refName },
      lte: { branch: refName }
    })
    for await (const file of existingFiles) {
      if (!newPaths.has(file.path)) {
        await this._db.delete('@gip/files', { branch: refName, path: file.path })
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
      const existing = await this._db.get('@gip/files', {
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
          timestamp: oldestInPack.timestamp
        }
      }

      // Idempotency: if the existing row already reflects the same blob,
      // mode, and metadata we'd write, skip the insert. Saves a write
      // round-trip on no-op pushes (e.g. retries).
      if (
        existing &&
        existing.oid === file.oid &&
        existing.mode === file.mode &&
        existing.message === meta.message &&
        existing.timestamp === meta.timestamp
      ) {
        continue
      }

      await this._db.insert('@gip/files', {
        branch: refName,
        path: file.path,
        oid: file.oid,
        mode: file.mode,
        size: file.size,
        author: meta.author,
        message: meta.message,
        timestamp: meta.timestamp
      })
    }

    // 5. Insert/update the branch record. No denormalized object list —
    // getRefObjects walks the graph from the tip, so the record only carries
    // the tip metadata. (Records written by older versions still hold their
    // lists; the walk is the fallback-free path for empty ones.)
    await this._db.insert('@gip/branches', {
      name: refName,
      commitOid: oid,
      treeOid: commit.tree,
      author: commit.author,
      message: commit.message,
      timestamp: commit.timestamp,
      objects: []
    })

    // 6. Set HEAD to first branch pushed (like git init)
    const currentHead = await this.getHead()
    if (!currentHead) {
      await this._db.insert('@gip/head', { branch: refName })
    }

    // 7. Flush
    await this._db.flush()
  }

  // --- Fetch support ---

  // opts.seen — a Set shared across calls so a multi-ref fetch (a clone
  // pulls every branch and tag) walks shared history once; objects already
  // seen are omitted from the result, the caller has them.
  async getRefObjects(oid, onLoad, opts = {}) {
    let record = null

    // Check branches first
    const branches = this._db.find('@gip/branches')
    for await (const b of branches) {
      if (b.commitOid === oid) {
        record = b
        break
      }
    }

    // Then check tags
    if (!record) {
      const tags = this._db.find('@gip/tags')
      for await (const t of tags) {
        if (t.oid === oid) {
          record = t
          break
        }
      }
    }

    if (!record) return []

    const seen = opts.seen ?? new Set()

    // Records written by older versions carry the denormalized reachable
    // set — serve it directly.
    if (record.objects && record.objects.length > 0) {
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
      } else if (obj.type === 'commit') {
        const commit = parseCommit(data)
        if (commit.tree) stack.push(commit.tree)
        for (const parent of commit.parents) stack.push(parent)
      } else if (obj.type === 'tree') {
        for (const entry of treeEntries(data)) stack.push(entry.oid)
      }
    }

    return results
  }

  // --- Drive ---

  async toDrive(branch) {
    // Check branches first, then tags
    const b = await this._db.get('@gip/branches', { name: branch })
    if (!b) {
      const t = await this._db.get('@gip/tags', { name: branch })
      if (!t) return null
      // Tags aren't file-indexed — serve the immutable tree lazily from the
      // tree objects instead.
      const drive = new TreeDrive(this._db, { treeOid: t.treeOid })
      await drive.ready()
      return drive
    }

    const drive = new RemoteDrive(this._db, { branch })
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

/**
 * Walk the first-parent commit chain (within `objects`) starting at HEAD,
 * and for each path in HEAD's tree return the metadata of the most recent
 * commit whose tree differs at that path from its parent's tree.
 *
 * Returns:
 *   - byPath:  Map<path, { author, message, timestamp }> for paths we
 *              could attribute within the pack.
 *   - oldest:  the oldest commit reached (used as a fallback by callers
 *              when the pack is shallow and a path was already at its
 *              current blob before the pack window).
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
            timestamp: chain[i].commit.timestamp
          })
          remaining.delete(path)
        }
      } else if (isRoot) {
        byPath.set(path, {
          author: chain[i].commit.author,
          message: chain[i].commit.message,
          timestamp: chain[i].commit.timestamp
        })
        remaining.delete(path)
      }
      // else: shallow boundary — caller falls back to existing row /
      // oldest-commit metadata.
    }
  }

  return {
    byPath,
    oldest: chain[chain.length - 1].commit
  }
}

module.exports = {
  Remote,
  RemoteDrive,
  GitPearLink,
  parseCommit,
  walkTree
}
