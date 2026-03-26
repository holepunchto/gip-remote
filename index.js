const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const Hyperbee = require('hyperbee2')
const { GitTree } = require('rebuild-git')
const def = require('./schema/hyperdb/index')
const RemoteDrive = require('./lib/drive')

// --- Git commit parser ---

function parseCommit(data) {
  const text = data.toString('utf8')
  const lines = text.split('\n')
  const result = { tree: null, parents: [], author: null, timestamp: 0, message: '' }

  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') {
      i++
      break
    }

    if (line.startsWith('tree ')) {
      result.tree = line.slice(5)
    } else if (line.startsWith('parent ')) {
      result.parents.push(line.slice(7))
    } else if (line.startsWith('author ')) {
      const match = line.match(/^author (.+) <.+> (\d+) [+-]\d+$/)
      if (match) {
        result.author = match[1]
        result.timestamp = parseInt(match[2])
      }
    }
  }

  result.message = lines.slice(i).join('\n').trim()
  return result
}

// --- Tree walker: extracts all file paths from git tree objects ---

function walkTree(objects, treeOid, prefix) {
  const treeObj = objects.get(treeOid)
  if (!treeObj || treeObj.type !== 'tree') return []

  const entries = GitTree.from(treeObj.data).entries()
  const files = []

  for (const entry of entries) {
    const path = prefix + '/' + entry.path
    if (entry.type === 'tree') {
      files.push(...walkTree(objects, entry.oid, path))
    } else {
      const blob = objects.get(entry.oid)
      files.push({
        path,
        oid: entry.oid,
        mode: entry.mode || '100644',
        size: blob ? blob.size : 0
      })
    }
  }

  return files
}

// --- Remote DB ---

class Remote extends ReadyResource {
  _swarm = null
  _store = null
  _db = null
  _key = null

  constructor(args = {}) {
    super()

    this._name = args.name
    this._store = args.store
    this._swarm = args.swarm
    this._timeout = args.timeout || 240_000
    this._blind = args.blind
    this._key = args.key

    const bee = new Hyperbee(this._store, { key: args.key })
    this._db = HyperDB.bee2(bee, def)

    this._onconnection = (conn) => {
      this._store.replicate(conn)
      this.emit('connection', conn)
    }

    this._swarm.on('connection', this._onconnection)
  }

  async _open() {
    await this._db.ready()

    this._topic = this._swarm.join(this.discoveryKey)

    await this._db.update()
  }

  async _close() {
    this._swarm.off('connection', this._onconnection)

    if (this._topic) await this._topic.destroy()

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
  parseCommit,
  walkTree
}
