const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Hyperbee = require('hyperbee2')
const def = require('./schema/hyperdb/index')
const RemoteDrive = require('./lib/drive')
const GitPearLink = require('./lib/link')
const { parseCommit, walkTree } = require('./lib/git')

class Remote extends ReadyResource {
  _swarm = null
  _store = null
  _db = null
  _key = null

  constructor(store, link, opts = {}) {
    super()

    this._link =
      typeof link === 'string' && link.startsWith('git+pear:') ? GitPearLink.parse(link) : link
    const config = typeof this._link === 'string' ? { name: this._link } : this._link

    const bee = new Hyperbee(store, config, { autoUpdate: true })
    this._db = HyperDB.bee2(bee, def, { autoUpdate: true })

    this._name = config.name || config.pathname.split('/').slice(1)[0]
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

  // --- Objects ---

  async getObject(oid) {
    return this._db.get('@gip/objects', { oid })
  }

  // --- Refs / Branches ---

  async getAllRefs() {
    const branches = this._db.find('@gip/branches')
    const refs = []

    for await (const b of branches) {
      refs.push({ ref: `refs/heads/${b.name}`, oid: b.commitOid })
    }

    const main = refs.find((r) => r.ref === 'refs/heads/main')
    if (main) refs.push({ ref: 'HEAD', oid: main.oid })

    return refs.reverse()
  }

  async getBranchRef(branch) {
    const b = await this._db.get('@gip/branches', { name: branch })
    if (!b) return null
    return { ref: `refs/heads/${b.name}`, oid: b.commitOid }
  }

  // --- Push: store objects + index branch + files ---

  async push(branchName, commitOid, objects) {
    // 1. Store all git objects
    for (const [oid, obj] of objects) {
      const existing = await this.getObject(oid)
      if (existing) continue

      await this._db.insert('@gip/objects', {
        oid,
        type: obj.type,
        size: obj.size,
        data: obj.data
      })
    }

    // 2. Parse commit metadata
    const commitObj = objects.get(commitOid)
    if (!commitObj) throw new Error('Commit object not found: ' + commitOid)

    const commit = parseCommit(commitObj.data)
    if (!commit.tree) throw new Error('Commit has no tree: ' + commitOid)

    // 3. Walk tree to enumerate files
    const files = walkTree(objects, commit.tree, '')

    // 4. Insert file records
    for (const file of files) {
      await this._db.insert('@gip/files', {
        branch: branchName,
        path: file.path,
        oid: file.oid,
        mode: file.mode,
        size: file.size,
        author: commit.author,
        message: commit.message,
        timestamp: commit.timestamp
      })
    }

    // 5. Insert branch record
    await this._db.insert('@gip/branches', {
      name: branchName,
      commitOid,
      treeOid: commit.tree,
      author: commit.author,
      message: commit.message,
      timestamp: commit.timestamp,
      objects: [...objects.keys()]
    })

    // 6. Flush
    await this._db.flush()
  }

  // --- Fetch support ---

  async getRefObjects(commitOid, onLoad) {
    const branches = this._db.find('@gip/branches')
    let branch = null

    for await (const b of branches) {
      if (b.commitOid === commitOid) {
        branch = b
        break
      }
    }

    if (!branch) return []

    const results = []
    for (const oid of branch.objects) {
      const obj = await this.getObject(oid)
      if (!obj) continue

      // Empty blobs have null data after round-tripping through compact-encoding
      const data = obj.data || Buffer.alloc(0)

      if (onLoad) onLoad(obj.size)
      results.push({ ...obj, data, id: oid })
    }

    return results
  }

  // --- Drive ---

  async toDrive(branch) {
    const b = await this._db.get('@gip/branches', { name: branch })
    if (!b) return null

    const drive = new RemoteDrive(this._db, { branch })
    await drive.ready()
    return drive
  }

  // --- Peer discovery ---

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
