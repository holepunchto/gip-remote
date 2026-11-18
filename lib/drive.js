const ReadyResource = require('ready-resource')
const MirrorDrive = require('mirror-drive')
const { Readable } = require('streamx')
const { getObject, objectStream } = require('./objects')
const { treeEntries, isUnsafeName } = require('./git')

class RemoteDrive extends ReadyResource {
  constructor(db, { branch = 'main' } = {}) {
    super()
    this._db = db
    this._branch = branch
  }

  async _open() {
    await this._db.ready()
  }

  _resolveKey(nameOrEntry) {
    if (typeof nameOrEntry === 'object' && nameOrEntry !== null) return nameOrEntry.key
    return nameOrEntry
  }

  async entry(nameOrEntry) {
    const key = this._resolveKey(nameOrEntry)
    const record = await this._db.get('@gip/files', {
      branch: this._branch,
      path: key
    })
    if (!record) return null

    return toEntry(key, record)
  }

  async get(nameOrEntry) {
    const key = this._resolveKey(nameOrEntry)
    const record = await this._db.get('@gip/files', {
      branch: this._branch,
      path: key
    })
    if (!record) return null

    const obj = await getObject(this._db, record.oid)
    if (!obj) return null
    return obj.data
  }

  createReadStream(entryOrKey) {
    const db = this._db
    const branch = this._branch
    const key = typeof entryOrKey === 'object' ? entryOrKey.key : entryOrKey

    let it = null

    return new Readable({
      async open(cb) {
        const record = await db.get('@gip/files', { branch, path: key })
        if (record) it = objectStream(db, record.oid)
        cb(null)
      },
      async read(cb) {
        try {
          if (it === null) {
            this.push(null)
            return cb(null)
          }
          const { done, value } = await it.next()
          this.push(done ? null : value)
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  _findRange(folder) {
    const branch = this._branch
    if (!folder || folder === '/') {
      // A bare { branch } is ignored by the key-range encoder (it would scan
      // every branch's files) — scope explicitly with a gte/lte prefix.
      return this._db.find('@gip/files-by-branch', { gte: { branch }, lte: { branch } })
    }

    return this._db.find('@gip/files-by-branch', {
      gte: { branch, path: folder + '/' },
      lt: { branch, path: folder + '0' } // '0' is the code point after '/'
    })
  }

  list(folder, opts) {
    const ignore = opts && opts.ignore
    const it = this._findRange(folder)[Symbol.asyncIterator]()

    return new Readable({
      async read(cb) {
        try {
          while (true) {
            const { done, value } = await it.next()
            if (done) {
              this.push(null)
              break
            }
            if (ignore && ignore(value.path)) continue
            this.push(toEntry(value.path, value))
            break
          }
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  readdir(folder) {
    const prefix = !folder || folder === '/' ? '/' : folder + '/'
    const seen = new Set()
    const it = this._findRange(folder)[Symbol.asyncIterator]()

    return new Readable({
      async read(cb) {
        try {
          while (true) {
            const { done, value } = await it.next()
            if (done) {
              this.push(null)
              break
            }
            const rest = prefix === '/' ? value.path.slice(1) : value.path.slice(prefix.length)
            const name = rest.split('/')[0]
            if (seen.has(name)) continue
            seen.add(name)
            this.push(name)
            break
          }
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  mirror(out, opts) {
    return new MirrorDrive(this, out, opts)
  }
}

// A drive over git tree objects — same surface as RemoteDrive, but resolved
// lazily from the object store instead of pre-indexed @gip/files rows. Used
// for tags: indexing every tag's full tree at push time made tag pushes
// O(tags × files); the tree objects are already in the store, so directory
// listings are one small object read each.
class TreeDrive extends ReadyResource {
  constructor(db, { treeOid } = {}) {
    super()
    this._db = db
    this._root = treeOid
    this._trees = new Map() // tree oid → Map(name → { oid, mode, type })
  }

  async _open() {
    await this._db.ready()
  }

  async _entries(oid) {
    if (this._trees.has(oid)) return this._trees.get(oid)
    const obj = await getObject(this._db, oid)
    const map = new Map()
    if (obj && obj.type === 'tree') {
      for (const e of treeEntries(obj.data)) {
        if (!isUnsafeName(e.path)) map.set(e.path, e)
      }
    }
    this._trees.set(oid, map)
    return map
  }

  async _find(path) {
    let cur = { oid: this._root, type: 'tree' }
    for (const name of path.split('/').filter(Boolean)) {
      if (cur.type !== 'tree') return null
      cur = (await this._entries(cur.oid)).get(name) ?? null
      if (!cur) return null
    }
    return cur
  }

  _key(nameOrEntry) {
    if (typeof nameOrEntry === 'object' && nameOrEntry !== null) return nameOrEntry.key
    return nameOrEntry
  }

  async entry(nameOrEntry) {
    const key = this._key(nameOrEntry)
    const found = await this._find(key)
    if (!found || found.type === 'tree') return null
    const record = await this._db.get('@gip/objects', { oid: found.oid })
    return toEntry(key, { mode: found.mode, size: record ? record.size : 0 })
  }

  async get(nameOrEntry) {
    const found = await this._find(this._key(nameOrEntry))
    if (!found || found.type === 'tree') return null
    const obj = await getObject(this._db, found.oid)
    return obj ? obj.data || Buffer.alloc(0) : null
  }

  createReadStream(entryOrKey) {
    const db = this._db
    const key = this._key(entryOrKey)
    const find = (path) => this._find(path)

    let it = null

    return new Readable({
      async open(cb) {
        const found = await find(key)
        if (found && found.type !== 'tree') it = objectStream(db, found.oid)
        cb(null)
      },
      async read(cb) {
        try {
          if (it === null) {
            this.push(null)
            return cb(null)
          }
          const { done, value } = await it.next()
          this.push(done ? null : value)
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  async _walk(prefix, oid, out) {
    for (const [name, e] of await this._entries(oid)) {
      const path = prefix + '/' + name
      if (e.type === 'tree') await this._walk(path, e.oid, out)
      else out.push({ path, e })
    }
  }

  list(folder, opts) {
    const ignore = opts && opts.ignore

    const collect = async () => {
      const start = !folder || folder === '/' ? '' : folder
      const dir = start === '' ? { oid: this._root, type: 'tree' } : await this._find(start)
      const out = []
      if (dir && dir.type === 'tree') await this._walk(start, dir.oid, out)

      const entries = []
      for (const { path, e } of out) {
        if (ignore && ignore(path)) continue
        const record = await this._db.get('@gip/objects', { oid: e.oid })
        entries.push(toEntry(path, { mode: e.mode, size: record ? record.size : 0 }))
      }
      return entries
    }

    let queue = null
    return new Readable({
      async read(cb) {
        try {
          if (queue === null) queue = await collect()
          this.push(queue.length ? queue.shift() : null)
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  readdir(folder) {
    const resolve = async () => {
      const dir =
        !folder || folder === '/' ? { oid: this._root, type: 'tree' } : await this._find(folder)
      if (!dir || dir.type !== 'tree') return []
      return [...(await this._entries(dir.oid)).keys()]
    }

    let queue = null
    return new Readable({
      async read(cb) {
        try {
          if (queue === null) queue = await resolve()
          this.push(queue.length ? queue.shift() : null)
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    })
  }

  mirror(out, opts) {
    return new MirrorDrive(this, out, opts)
  }
}

function toEntry(key, record) {
  return {
    key,
    value: {
      executable: record.mode === '100755',
      linkname: null,
      blob: {
        blockOffset: 0,
        blockLength: 0,
        byteOffset: 0,
        byteLength: record.size
      },
      metadata: null
    }
  }
}

module.exports = RemoteDrive
module.exports.TreeDrive = TreeDrive
