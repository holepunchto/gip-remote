const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Hyperbee = require('hyperbee2')
const z32 = require('z32')
const def = require('./schema/hyperdb/index')
const RemoteDrive = require('./lib/drive')
const GitPearLink = require('./lib/link')
const { parseCommit, parseTag, walkTree } = require('./lib/git')

class Remote extends ReadyResource {
  _swarm = null
  _store = null
  _db = null
  _key = null

  constructor(store, link, opts = {}) {
    super()

    this._link =
      typeof link === 'string' && link.startsWith('git+pear:') ? GitPearLink.parse(link) : link

    let config
    if (typeof this._link === 'string') {
      this._name = this._link
      config = { core: store.get({ name: this._link }) }
    } else if (this._link.drive) {
      this._name = this._link.pathname?.split('/').slice(1)[0]
      config = { key: this._link.drive.key }
    } else {
      this._name = this._link.name
      config = this._link
    }

    config.autoUpdate = true
    const bee = new Hyperbee(store, config)
    this._db = HyperDB.bee2(bee, def, { autoUpdate: true })

    this._timeout = opts.timeout || 240_000
    this._blind = opts.blind
  }

  async _open() {
    await this._db.ready()
  }

  async _close() {
    await this._db.close()
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
    return this._db.get('@gip/objects', { oid })
  }

  // --- Refs / Branches ---

  async getHead() {
    const record = await this._db.get('@gip/head', {})
    return record ? record.branch : null
  }

  async setHead(branch) {
    await this._db.insert('@gip/head', { branch })
    await this._db.flush()
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
    const branch = await this._db.get('@gip/branches', { name: branchName })
    if (!branch) return false

    await this._db.delete('@gip/branches', { name: branchName })

    // Remove file records for this branch
    const files = this._db.find('@gip/files', { branch: branchName })
    for await (const file of files) {
      await this._db.delete('@gip/files', { branch: branchName, path: file.path })
    }

    await this._db.flush()
    return true
  }

  async deleteTag(tagName) {
    const tag = await this._db.get('@gip/tags', { name: tagName })
    if (!tag) return false

    await this._db.delete('@gip/tags', { name: tagName })

    // Remove file records for this tag
    const filesBranch = 'tags/' + tagName
    const files = this._db.find('@gip/files', { branch: filesBranch })
    for await (const file of files) {
      await this._db.delete('@gip/files', { branch: filesBranch, path: file.path })
    }

    await this._db.flush()
    return true
  }

  // --- Push: store objects + index branch/tag + files ---

  async push(refName, oid, objects) {
    // 1. Store all git objects
    for (const [objOid, obj] of objects) {
      const existing = await this.getObject(objOid)
      if (existing) continue

      await this._db.insert('@gip/objects', {
        oid: objOid,
        type: obj.type,
        size: obj.size,
        data: obj.data
      })
    }

    // 2. Dereference tag objects to find the commit
    let resolvedOid = oid
    let obj = objects.get(resolvedOid)
    if (!obj) throw new Error('Object not found: ' + resolvedOid)

    let tagMeta = null
    while (obj.type === 'tag') {
      const tag = parseTag(obj.data)
      if (!tagMeta) tagMeta = tag
      if (!tag.object) throw new Error('Tag has no object: ' + resolvedOid)
      resolvedOid = tag.object
      obj = objects.get(resolvedOid)
      if (!obj) throw new Error('Object not found: ' + resolvedOid)
    }

    if (obj.type !== 'commit') {
      throw new Error('Expected commit, got ' + obj.type + ': ' + resolvedOid)
    }

    const commit = parseCommit(obj.data)
    if (!commit.tree) throw new Error('Commit has no tree: ' + resolvedOid)

    // 3. Walk tree to enumerate files
    const files = walkTree(objects, commit.tree, '')

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
    const existingFiles = this._db.find('@gip/files', { branch: refName })
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

    const isTag = refName.startsWith('tags/')

    if (isTag) {
      // 5a. Insert tag record
      const tagName = refName.slice(5) // strip 'tags/'
      await this._db.insert('@gip/tags', {
        name: tagName,
        oid,
        commitOid: resolvedOid,
        treeOid: commit.tree,
        tagger: tagMeta ? tagMeta.tagger : null,
        message: tagMeta ? tagMeta.message : null,
        timestamp: tagMeta ? tagMeta.timestamp : 0,
        objects: [...objects.keys()]
      })
    } else {
      // 5b. Insert/update branch record.
      //
      // `objects` is the denormalized "everything reachable from this branch"
      // set used by getRefObjects() at fetch time. CRITICAL: we must MERGE
      // with the prior record's objects, not overwrite. A real git client
      // sends a thin pack on follow-up pushes (only the new objects), so
      // `objects.keys()` here would be e.g. just {commit B, new tree} —
      // commit A and its tree from the previous push would be dropped from
      // the list, and a fresh clone calling getRefObjects(headOfB) would be
      // missing every parent commit. That's the "I cloned and lost a
      // commit" symptom.
      const prev = await this._db.get('@gip/branches', { name: refName })
      const merged = new Set(prev ? prev.objects : [])
      for (const k of objects.keys()) merged.add(k)

      await this._db.insert('@gip/branches', {
        name: refName,
        commitOid: oid,
        treeOid: commit.tree,
        author: commit.author,
        message: commit.message,
        timestamp: commit.timestamp,
        objects: [...merged]
      })

      // 6. Set HEAD to first branch pushed (like git init)
      const currentHead = await this.getHead()
      if (!currentHead) {
        await this._db.insert('@gip/head', { branch: refName })
      }
    }

    // 7. Flush
    await this._db.flush()
  }

  // --- Fetch support ---

  async getRefObjects(oid, onLoad) {
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

    const results = []
    for (const objOid of record.objects) {
      const obj = await this.getObject(objOid)
      if (!obj) continue

      // Empty blobs have null data after round-tripping through compact-encoding
      const data = obj.data || Buffer.alloc(0)

      if (onLoad) onLoad(obj.size)
      results.push({ ...obj, data, id: objOid })
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
      // For tags, files are stored under 'tags/<name>'
      const drive = new RemoteDrive(this._db, { branch: 'tags/' + branch })
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
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(interval)
        reject(new Error(`Timeout waiting for peers after ${this._timeout}ms`))
      }, this._timeout)

      const interval = setInterval(async () => {
        if (this.availablePeers > 0) {
          clearInterval(interval)
          clearTimeout(timeout)
          await this._db.update()
          resolve()
        } else {
          await this._db.update()
        }
      }, 500)
    })
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
