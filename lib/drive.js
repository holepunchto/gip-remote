const ReadyResource = require('ready-resource')
const MirrorDrive = require('mirror-drive')
const { Readable } = require('streamx')

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

    return {
      key,
      value: {
        executable: record.mode === '100755',
        linkname: null,
        blob: { byteLength: record.size },
        metadata: null
      }
    }
  }

  async get(nameOrEntry) {
    const key = this._resolveKey(nameOrEntry)
    const record = await this._db.get('@gip/files', {
      branch: this._branch,
      path: key
    })
    if (!record) return null

    const obj = await this._db.get('@gip/objects', { oid: record.oid })
    if (!obj) return null
    return obj.data
  }

  createReadStream(entryOrKey) {
    const self = this
    const key = typeof entryOrKey === 'object' ? entryOrKey.key : entryOrKey

    return new Readable({
      async read(cb) {
        try {
          const buf = await self.get(key)
          if (buf) this.push(buf)
          this.push(null)
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
      return this._db.find('@gip/files-by-branch', { branch })
    }

    return this._db.find('@gip/files-by-branch', {
      gte: { branch, path: folder + '/' },
      lt: { branch, path: folder + '/\uffff' }
    })
  }

  list(folder, opts) {
    const ignore = opts && opts.ignore
    const stream = this._findRange(folder)

    return new Readable({
      async read(cb) {
        try {
          for await (const record of stream) {
            if (ignore && ignore(record.path)) continue
            this.push(record.path)
          }
          this.push(null)
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
    const stream = this._findRange(folder)

    return new Readable({
      async read(cb) {
        try {
          for await (const record of stream) {
            const rest = prefix === '/' ? record.path.slice(1) : record.path.slice(prefix.length)
            const name = rest.split('/')[0]
            if (!seen.has(name)) {
              seen.add(name)
              this.push(name)
            }
          }
          this.push(null)
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

module.exports = RemoteDrive
