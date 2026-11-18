const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Hyperbee = require('hyperbee2')
const ScopeLock = require('scope-lock')
const z32 = require('z32')
const def = require('./schema/hyperdb/index')
const RemoteDrive = require('./lib/drive')
const cacheBlocks = require('./lib/block-cache')
const GitPearLink = require('./lib/link')
const {
  parseCommit,
  parseTag,
  walkTree,
  treeEntries,
  isUnsafeName,
  objectLinks
} = require('./lib/git')
const {
  getObject,
  readObject,
  join,
  deflateInline,
  putChunked,
  OBJECT_CHUNK_SIZE
} = require('./lib/objects')
const { TreeDrive } = RemoteDrive

// Objects are written, and rows read, this many at a time, and a batch of
// objects is also cut at this many bytes.
const BATCH = 256
const BATCH_BYTES = 8 * 1024 * 1024
const TREE_CACHE = 256
// File index rows per transaction
const ROWS = 4096
// The path of the @gip/file-commits row that names the tree a branch's file
// index is of. No file has it: paths start with a slash.
const INDEXED = ''
const BLOCK_CACHE_BYTES = 32 * 1024 * 1024
const EMPTY = Buffer.alloc(0)

class Remote extends ReadyResource {
  _db = null
  _link = null
  _name = null
  _timeout = 0
  _writeLock = new ScopeLock()
  // Oids this session knows are in the store with everything they link to.
  // Objects are append-only, so that never goes stale. Saves re-checking the
  // shared thin set on every ref of a multi-ref push (git push --tags is one
  // push() per tag).
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
    cacheBlocks(bee.core, BLOCK_CACHE_BYTES)
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
    return this._locked(() => this._write(fn, landed))
  }

  async _write(fn, landed) {
    const writes = new Writes(this._db)
    let result
    try {
      result = await fn(writes)
      await writes.flush()
    } catch (err) {
      writes.close()
      throw err
    }
    if (landed) landed(result)
    return result
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
      (w) => w.tx.insert('@gip/head', { branch }),
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
    return this._transaction((w) => this._deleteBranch(w, branchName))
  }

  async _deleteBranch(w, branchName) {
    const branch = await w.get('@gip/branches', { name: branchName })
    if (!branch) return false

    const paths = await this._indexedPaths(w, branchName)
    await w.tx.delete('@gip/branches', { name: branchName })
    await w.tx.delete('@gip/file-commits', { branch: branchName, path: INDEXED })
    await this._unindex(w, branchName, paths)

    return true
  }

  // The paths of a branch's file records. Read to the end before anything
  // is written: the writes that follow may span transactions.
  async _indexedPaths(w, branch) {
    const paths = []
    const files = w.tx.find('@gip/files', { gte: { branch }, lte: { branch } })
    for await (const file of files) paths.push(file.path)
    return paths
  }

  async _unindex(w, branch, paths) {
    for (const path of paths) {
      await w.delete('@gip/files', { branch, path })
      await w.delete('@gip/file-commits', { branch, path })
    }
  }

  async deleteTag(tagName) {
    return this._transaction((w) => this._deleteTag(w, tagName))
  }

  async _deleteTag(w, tagName) {
    const tag = await w.get('@gip/tags', { name: tagName })
    if (!tag) return false

    await w.tx.delete('@gip/tags', { name: tagName })

    // Tags pushed by older versions were file-indexed as the branch
    // `tags/<name>`. A real branch of that name owns those rows.
    const filesBranch = 'tags/' + tagName
    if (await w.get('@gip/branches', { name: filesBranch })) return true

    await this._unindex(w, filesBranch, await this._indexedPaths(w, filesBranch))
    return true
  }

  // Delete `refs/heads/<name>` or `refs/tags/<name>`. `opts.expect` as in
  // pushRef. The head branch can't be deleted this way (DELETE_HEAD).
  async deleteRef(ref, opts = {}) {
    const target = parseRef(ref)

    return this._transaction(async (w) => {
      await this._expect(w, target, opts.expect)
      if (target.tag) return this._deleteTag(w, target.name)

      const head = await w.get('@gip/head', {})
      if (head && head.branch === target.name && (await this._tip(w, target)) !== null) {
        throw error('DELETE_HEAD', 'Refusing to delete the head branch: ' + ref)
      }
      return this._deleteBranch(w, target.name)
    })
  }

  async _tip(db, target) {
    if (target.tag) {
      const tag = await db.get('@gip/tags', { name: target.name })
      return tag ? tag.oid : null
    }
    const branch = await db.get('@gip/branches', { name: target.name })
    return branch ? branch.commitOid : null
  }

  // expect: undefined = no check, null = the ref must not exist, an oid = the
  // ref must be at it. Runs inside the transaction that then writes the ref.
  async _expect(db, target, expect) {
    if (expect === undefined) return
    const tip = await this._tip(db, target)
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
  // objects the remote doesn't have yet.
  //
  // Objects are content-addressed, so they are written first, as they come
  // and a bounded batch at a time. One small transaction then checks
  // `expect` and moves the ref. The ref is either where it was or at `oid`
  // with everything it reaches; a push that fails or dies half way leaves at
  // most objects no ref points at, which the next push reuses.
  async pushRef(ref, oid, objects, opts = {}) {
    const target = parseRef(ref)

    // One push at a time, start to end: a second one may count on the
    // objects of the first.
    await this._locked(async () => {
      // A stale push shouldn't write its objects first. Checked again, for
      // real, in the transaction that moves the ref.
      await this._expect(this._db, target, opts.expect)

      const sent = await this._store(objects)

      await this._write(
        (w) => this._point(w, target, oid, sent, opts),
        (head) => {
          if (head) this._autoHead = head
        }
      )
    })
  }

  async _has(oid) {
    return this._storedOids.has(oid) || (await this._db.get('@gip/objects', { oid })) !== null
  }

  // Write the objects the remote doesn't have, and check that whatever they
  // link to is in the push or in the store (MISSING_OBJECTS). Returns the
  // oids of the push. Memory is one batch plus those oids.
  async _store(source) {
    const sent = new Set()
    const wanted = new Set()
    let batch = []
    let bytes = 0

    const flush = async () => {
      const objects = batch
      batch = []
      bytes = 0
      if (objects.length > 0) await this._putBatch(objects)
    }

    const entries = source instanceof Map ? source : withOids(source)
    for await (let [oid, obj] of entries) {
      if (sent.has(oid)) continue
      sent.add(oid)
      wanted.delete(oid)
      // Stored and checked earlier this session
      if (this._storedOids.has(oid)) continue

      if (obj.size > OBJECT_CHUNK_SIZE) {
        // Only a blob is worth streaming: anything else has links to read
        if (obj.chunks && obj.type !== 'blob') obj = await join({ ...obj })
        await flush()
        await this._putChunked(oid, obj)
      } else {
        if (obj.chunks) obj = await join({ ...obj })
        bytes += obj.size
        if (batch.push([oid, obj]) === BATCH || bytes >= BATCH_BYTES) await flush()
      }

      for (const link of objectLinks(obj)) {
        if (!sent.has(link)) wanted.add(link)
      }
    }
    await flush()

    const boundary = [...wanted]
    const missing = []
    for (let i = 0; i < boundary.length; i += BATCH) {
      const slice = boundary.slice(i, i + BATCH)
      const existing = await Promise.all(slice.map((oid) => this._has(oid)))
      for (let j = 0; j < slice.length; j++) if (!existing[j]) missing.push(slice[j])
    }
    if (missing.length > 0) throw missingObjects(missing)

    for (const oid of sent) this._storedOids.add(oid)
    return sent
  }

  async _putBatch(objects) {
    return this._write(async (w) => {
      const fresh = await this._fresh(objects)
      const deflated = fresh.map(([, obj]) => deflateInline(obj.data || EMPTY))
      for (let i = 0; i < fresh.length; i++) {
        const [oid, { type, size }] = fresh[i]
        await w.tx.insert('@gip/objects', { oid, type, size, data: deflated[i] })
      }
    })
  }

  async _fresh(objects) {
    // The presence check is cheap (the stub row exists for chunked objects
    // too) and runs as one batch instead of an awaited round-trip per object.
    const existing = await Promise.all(objects.map(([oid]) => this._has(oid)))
    return objects.filter((_, i) => !existing[i])
  }

  async _putChunked(oid, obj) {
    if (await this._has(oid)) return

    let tx = this._db.transaction()
    try {
      await putChunked(
        () => tx,
        oid,
        obj,
        async () => {
          await tx.flush()
          tx = this._db.transaction()
        }
      )
      await tx.flush()
    } catch (err) {
      tx.close()
      throw err
    }
  }

  // The object a ref can point at: its type, and its payload unless it is a
  // large blob.
  async _resolve(db, oid) {
    const obj = await readObject(db, oid)
    if (obj && obj.chunks && obj.type !== 'blob') await join(obj)
    return obj
  }

  // Move the ref: everything read here is in the store. For a branch the
  // file index follows the ref. A large index is written over several
  // transactions, the ref with the first; until the last one lands toDrive
  // serves the branch from its tree instead.
  async _point(w, target, oid, sent, opts) {
    await this._expect(w, target, opts.expect)

    // 1. Dereference tag objects to find what the ref peels to
    let resolvedOid = oid
    let obj = await this._resolve(w, resolvedOid)
    if (!obj) throw missingObjects([resolvedOid])

    let tagMeta = null
    while (obj.type === 'tag') {
      const tag = parseTag(obj.data)
      if (!tagMeta) tagMeta = tag
      if (!tag.object) throw new Error('Tag has no object: ' + resolvedOid)
      resolvedOid = tag.object
      obj = await this._resolve(w, resolvedOid)
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
      await w.tx.insert('@gip/tags', {
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

    // 2. Work out the file index of the new tip, before anything is written
    const entries = treeReader(w)

    // a. Enumerate the files of the tree, from the store: a thin push
    //    doesn't re-send unchanged sub-trees.
    const files = await walkFiles(entries, commit.tree, '', [])

    // b. Reconcile deletions — file records whose paths no longer exist in
    //    the new tree. Without this, files removed in a commit would persist
    //    in the index forever (only `deleteBranch` cleans them up, and only
    //    on full branch deletion). The drive view would keep showing ghost
    //    files; consumers iterating @gip/files would emit stale entries.
    const newPaths = new Set(files.map((f) => f.path))
    const gone = (await this._indexedPaths(w, refName)).filter((path) => !newPaths.has(path))

    // c. Find, for each file, the most recent commit IN THIS PUSH that
    //    actually changed its blob — that's the commit we want to credit on
    //    the @gip/files row. If we just stamped every file with the tip's
    //    metadata, a fresh push of a multi-commit history would make every
    //    file look like it was last edited by the tip, which is useless for
    //    a tree view.
    const lastTouch = await fileLastTouch(w, entries, sent, resolvedOid, commit, newPaths)

    // 3. Insert/update the branch record. No denormalized object list —
    // getRefObjects walks the graph from the tip, so the record only carries
    // the tip metadata. (Records written by older versions still hold their
    // lists; the walk is the fallback-free path for empty ones.)
    await w.tx.insert('@gip/branches', {
      name: refName,
      commitOid: oid,
      treeOid: commit.tree,
      author: commit.author,
      message: commit.message,
      timestamp: commit.timestamp,
      objects: []
    })

    // 4. Default the head: the first branch pushed, until main (else master)
    // arrives in the same session. A head set with setHead is never moved.
    const head = await w.get('@gip/head', {})
    const defaulted =
      !head || (head.branch === this._autoHead && headRank(refName) < headRank(head.branch))
    if (defaulted) await w.tx.insert('@gip/head', { branch: refName })

    // 5. Write the file index. It is marked as behind the ref until its last
    // row is in.
    await w.tx.insert('@gip/file-commits', { branch: refName, path: INDEXED, commitOid: '' })
    await this._unindex(w, refName, gone)
    await this._index(w, refName, files, lastTouch)
    await w.tx.insert('@gip/file-commits', {
      branch: refName,
      path: INDEXED,
      commitOid: commit.tree
    })

    return defaulted ? refName : null
  }

  // Bring the @gip/files rows of a branch in line with `files`.
  //
  // Cases the fallback below handles:
  //   - The push is thin or shallow and the path was already at this blob
  //     before its oldest commit — keep the existing row as-is.
  //   - First push containing a root commit — files appearing in the root
  //     take the root commit's metadata.
  async _index(w, refName, files, lastTouch) {
    const oldestInPush = lastTouch.oldest

    for (let i = 0; i < files.length; i += BATCH) {
      const slice = files.slice(i, i + BATCH)
      const rows = await Promise.all(
        slice.map((file) => w.get('@gip/files', { branch: refName, path: file.path }))
      )

      for (let j = 0; j < slice.length; j++) {
        const file = slice[j]
        const existing = rows[j]

        let meta = lastTouch.byPath.get(file.path)

        if (!meta) {
          // No commit in this push changed this file. Either it's been at
          // this blob since before our window, or the push is shallow.
          if (existing && existing.oid === file.oid && existing.mode === file.mode) {
            // Genuinely unchanged from prior push — leave row alone.
            continue
          }
          // Fall back to the oldest commit we have. Best approximation when
          // a shallow clone is being seeded (we don't have the real
          // introducing commit, but the oldest commit in the push is a
          // strict upper bound on "when it could have last changed" given
          // what we know).
          meta = {
            author: oldestInPush.author,
            message: oldestInPush.message,
            timestamp: oldestInPush.timestamp,
            commitOid: oldestInPush.oid
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
          const attributed = await w.get('@gip/file-commits', {
            branch: refName,
            path: file.path
          })
          if (!attributed) {
            await w.insert('@gip/file-commits', {
              branch: refName,
              path: file.path,
              commitOid: meta.commitOid
            })
          }
          continue
        }

        // Submodule commits aren't in the store
        const blob = file.mode === '160000' ? null : await w.get('@gip/objects', { oid: file.oid })

        await w.insert('@gip/files', {
          branch: refName,
          path: file.path,
          oid: file.oid,
          mode: file.mode,
          size: blob ? blob.size : 0,
          author: meta.author,
          message: meta.message,
          timestamp: meta.timestamp
        })
        await w.insert('@gip/file-commits', {
          branch: refName,
          path: file.path,
          commitOid: meta.commitOid
        })
      }
    }
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
  async getRefObjects(oid, onLoad, opts) {
    const results = []
    for await (const obj of this.refObjects(oid, opts)) {
      if (obj.chunks) await join(obj)
      if (onLoad) onLoad(obj.size)
      results.push(obj)
    }
    return results
  }

  // getRefObjects as an async iterator: objects are yielded as the walk
  // reaches them and nothing but `opts.seen` is kept. A blob too large for
  // one block has `chunks`, an async iterable of buffers, instead of `data`.
  async *refObjects(oid, opts = {}) {
    const tip = (await this._tips()).get(oid)
    if (!tip) return

    const seen = opts.seen ?? new Set()

    // Records written by older versions carry the denormalized reachable
    // set — serve it directly. Only those need reading in full.
    const record = tip.legacy ? await this._db.get(tip.collection, { name: tip.name }) : null

    // Otherwise walk the object graph from the tip — pushes guarantee every
    // reachable object is in the store, so traversal replaces the stored
    // list. Missing parents just bound the walk (shallow-seeded repos).
    const walk = record === null
    const stack = walk ? [oid] : record.objects.slice().reverse()

    while (stack.length > 0) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)

      const obj = await readObject(this._db, cur)
      if (!obj) continue

      if (obj.chunks && obj.type !== 'blob') await join(obj)
      // Empty blobs have null data after round-tripping through compact-encoding
      if (!obj.chunks && !obj.data) obj.data = EMPTY
      obj.id = cur

      if (walk) for (const link of objectLinks(obj)) stack.push(link)
      yield obj
    }
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

  async _branchDrive(name) {
    const branch = await this._db.get('@gip/branches', { name })
    if (!branch) return null

    // A push moves the ref first and may still be writing the file index,
    // or have died doing so: the tree is then the truth.
    const indexed = await this._db.get('@gip/file-commits', { branch: name, path: INDEXED })
    const drive =
      indexed && indexed.commitOid !== branch.treeOid
        ? new TreeDrive(this._db, { treeOid: branch.treeOid })
        : new RemoteDrive(this._db, { branch: name })
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

// Rows written under the write lock, cut into transactions of ROWS so that a
// large file index never sits in one. What is written before the first cut
// lands together: the ref a push moves and, for all but the largest pushes,
// its whole index. Reads see what has been written so far.
class Writes {
  constructor(db) {
    this._db = db
    this._rows = 0
    this.tx = db.transaction()
  }

  get(collection, key) {
    return this.tx.get(collection, key)
  }

  async insert(collection, row) {
    await this.tx.insert(collection, row)
    await this._wrote()
  }

  async delete(collection, key) {
    await this.tx.delete(collection, key)
    await this._wrote()
  }

  async _wrote() {
    if (++this._rows < ROWS) return
    this._rows = 0
    await this.tx.flush()
    this.tx = this._db.transaction()
  }

  flush() {
    return this.tx.flush()
  }

  close() {
    this.tx.close()
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

// A Map hands out [oid, object]; so does anything else, through this.
async function* withOids(objects) {
  for await (const obj of objects) yield [obj.oid, obj]
}

// Tree entries by tree oid, read from the store, with the names that must
// never become paths left out. Keeps the last few trees: a walk down a
// history reads each one as a commit's tree and again as its child's parent.
function treeReader(db) {
  const cache = new Map()

  return async function entries(oid) {
    const cached = cache.get(oid)
    if (cached) return cached

    const obj = await getObject(db, oid)
    const list =
      obj && obj.type === 'tree' ? treeEntries(obj.data).filter((e) => !isUnsafeName(e.path)) : []

    if (cache.size === TREE_CACHE) cache.delete(cache.keys().next().value)
    cache.set(oid, list)
    return list
  }
}

async function walkFiles(entries, treeOid, prefix, files) {
  for (const entry of await entries(treeOid)) {
    const path = prefix + '/' + entry.path
    if (entry.type === 'tree') await walkFiles(entries, entry.oid, path, files)
    else files.push({ path, oid: entry.oid, mode: entry.mode })
  }
  return files
}

// The files under tree `cur` that tree `par` (null for none) doesn't have at
// the same blob. Only sub-trees that differ are read.
async function changedFiles(entries, cur, par, prefix, changed) {
  if (cur === par) return changed

  const before = new Map()
  if (par !== null) for (const entry of await entries(par)) before.set(entry.path, entry)

  for (const entry of await entries(cur)) {
    const path = prefix + '/' + entry.path
    const was = before.get(entry.path)
    if (entry.type === 'tree') {
      const sub = was && was.type === 'tree' ? was.oid : null
      await changedFiles(entries, entry.oid, sub, path, changed)
    } else if (!was || was.type === 'tree' || was.oid !== entry.oid) {
      changed.push(path)
    }
  }
  return changed
}

/**
 * Walk the first-parent commit chain from the tip through the commits of
 * this push (`sent`), and for each of `paths` (the files of the tip's tree)
 * find the most recent commit whose tree differs at that path from its
 * parent's tree. We don't follow merge parents — same heuristic GitHub's
 * "blame" uses; it keeps cost predictable and matches user expectation.
 *
 * Returns:
 *   - byPath:  Map<path, { author, message, timestamp, commitOid }> for
 *              paths we could attribute within the push.
 *   - oldest:  the oldest commit reached, with its `oid` (used as a
 *              fallback by callers when the push is thin or shallow and a
 *              path was already at its current blob before it).
 */
async function fileLastTouch(db, entries, sent, tipOid, tip, paths) {
  const byPath = new Map()
  const remaining = new Set(paths)
  let oid = tipOid
  let commit = tip

  const credit = (changed) => {
    const meta = {
      author: commit.author,
      message: commit.message,
      timestamp: commit.timestamp,
      commitOid: oid
    }
    for (const path of changed) {
      if (remaining.delete(path)) byPath.set(path, meta)
    }
  }

  while (remaining.size > 0) {
    // True root commit (no parents at all) — files appearing here are new,
    // so they're attributed to this commit. We must NOT do the same when
    // we ran out of push (parents exist, just not in it), or we'd make up
    // an attribution that isn't real.
    if (commit.parents.length === 0) {
      credit(await changedFiles(entries, commit.tree, null, '', []))
      break
    }

    const parentOid = commit.parents[0]
    const parent = sent.has(parentOid) ? await getObject(db, parentOid) : null
    if (!parent || parent.type !== 'commit') break

    const parentCommit = parseCommit(parent.data)
    credit(await changedFiles(entries, commit.tree, parentCommit.tree, '', []))
    oid = parentOid
    commit = parentCommit
  }

  return { byPath, oldest: { ...commit, oid } }
}

module.exports = {
  Remote,
  RemoteDrive,
  GitPearLink,
  parseCommit,
  walkTree
}
