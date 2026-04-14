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

    if (obj.type !== 'commit') throw new Error('Expected commit, got ' + obj.type + ': ' + resolvedOid)

    const commit = parseCommit(obj.data)
    if (!commit.tree) throw new Error('Commit has no tree: ' + resolvedOid)

    // 3. Walk tree to enumerate files
    const files = walkTree(objects, commit.tree, '')

    // 4. Insert file records
    for (const file of files) {
      await this._db.insert('@gip/files', {
        branch: refName,
        path: file.path,
        oid: file.oid,
        mode: file.mode,
        size: file.size,
        author: commit.author,
        message: commit.message,
        timestamp: commit.timestamp
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
      // 5b. Insert branch record
      await this._db.insert('@gip/branches', {
        name: refName,
        commitOid: oid,
        treeOid: commit.tree,
        author: commit.author,
        message: commit.message,
        timestamp: commit.timestamp,
        objects: [...objects.keys()]
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

module.exports = {
  Remote,
  RemoteDrive,
  GitPearLink,
  parseCommit,
  walkTree
}
