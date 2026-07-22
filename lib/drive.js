const ReadyResource = require('ready-resource')
const MirrorDrive = require('mirror-drive')
const { Readable } = require('streamx')
const { getObject, objectStream } = require('./objects')

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
      lt: { branch, path: folder + '/\uffff' }
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
