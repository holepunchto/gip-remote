const zlib = require('zlib')
const crypto = require('crypto')
const b4a = require('b4a')
const { dirname, join, resolve } = require('path')
const { promises: defaultFs } = require('fs')

// Below this many objects a fetch is written loose, like git's own
// fetch.unpackLimit: a pack per small fetch would pile up packs.
const PACK_MIN_OBJECTS = 100
const PACK_TYPES = { commit: 1, tree: 2, blob: 3, tag: 4 }
const WRITE_BUFFER = 4 * 1024 * 1024

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

// --- Git tag parser ---

function parseTag(data) {
  const text = data.toString('utf8')
  const lines = text.split('\n')
  const result = { object: null, type: null, tag: null, tagger: null, timestamp: 0, message: '' }

  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') {
      i++
      break
    }

    if (line.startsWith('object ')) result.object = line.slice(7)
    else if (line.startsWith('type ')) result.type = line.slice(5)
    else if (line.startsWith('tag ')) result.tag = line.slice(4)
    else if (line.startsWith('tagger ')) {
      const match = line.match(/^tagger (.+) <.+> (\d+) [+-]\d+$/)
      if (match) {
        result.tagger = match[1]
        result.timestamp = parseInt(match[2])
      }
    }
  }

  result.message = lines.slice(i).join('\n').trim()
  return result
}

// --- Tree parsing ---

// Entries of a single tree object: { path, oid, mode, type }. Never throws:
// git accepts any octal mode and any name, and so do we. `mode` is canonical
// the way git canonicalises it (100664 reads as 100644); the tree's own bytes
// are never rewritten.
function treeEntries(data) {
  const entries = []
  let cursor = 0

  // An empty tree comes back from the store with null data
  while (data && cursor < data.byteLength) {
    const space = data.indexOf(32, cursor)
    const nul = space === -1 ? -1 : data.indexOf(0, space)
    if (nul === -1) break

    const bits = parseInt(b4a.toString(data, 'latin1', cursor, space), 8)
    const kind = bits & 0o170000
    let mode = '160000'
    let type = 'commit'
    if (kind === 0o040000) {
      mode = '040000'
      type = 'tree'
    } else if (kind === 0o100000) {
      mode = bits & 0o100 ? '100755' : '100644'
      type = 'blob'
    } else if (kind === 0o120000) {
      mode = '120000'
      type = 'blob'
    }

    entries.push({
      mode,
      path: b4a.toString(data, 'utf8', space + 1, nul),
      oid: b4a.toString(data, 'hex', nul + 1, nul + 21),
      type
    })
    cursor = nul + 21
  }

  return entries
}

// Names git stores but that must never become a path: a checkout or a drive
// mirror of them could write outside the tree, or into .git.
function isUnsafeName(name) {
  return (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.toLowerCase() === '.git' ||
    name.includes('/') ||
    name.includes('\\')
  )
}

// The oids an object links to, the ones a clone of it needs. Submodule
// commits (gitlinks) live in another repository.
function objectLinks(obj) {
  if (obj.type === 'commit') {
    const commit = parseCommit(obj.data)
    return commit.tree ? [commit.tree, ...commit.parents] : commit.parents
  }
  if (obj.type === 'tag') {
    const tag = parseTag(obj.data)
    return tag.object ? [tag.object] : []
  }
  if (obj.type === 'tree') {
    const links = []
    for (const entry of treeEntries(obj.data)) {
      if (entry.type !== 'commit') links.push(entry.oid)
    }
    return links
  }
  return []
}

// --- Tree walker: extracts all file paths from git tree objects ---

// Unsafe names (and everything below them) are left out: this feeds the
// file index and the drive view, never the object store.
function walkTree(objects, treeOid, prefix, missing, files = []) {
  const treeObj = objects.get(treeOid)
  if (!treeObj || treeObj.type !== 'tree') {
    // Thin packs don't re-send unchanged sub-trees. Report what we couldn't
    // expand so the caller can pull it from its object store and re-walk.
    if (!treeObj && missing) missing.push(treeOid)
    return files
  }

  for (const entry of treeEntries(treeObj.data)) {
    if (isUnsafeName(entry.path)) continue
    const path = prefix + '/' + entry.path
    if (entry.type === 'tree') {
      walkTree(objects, entry.oid, path, missing, files)
    } else {
      const blob = objects.get(entry.oid)
      files.push({ path, oid: entry.oid, mode: entry.mode, size: blob ? blob.size : 0 })
    }
  }

  return files
}

// --- Writing a repository ---

/**
 * Write git objects into a git dir, as loose objects or as one pack.
 *
 * @param {object} opts
 * @param {string} opts.gitDir - The git dir itself: `repo/.git`, a bare repo,
 *   a linked worktree's `.git/worktrees/x`, or a `.git` file pointing at one
 * @param {string} [opts.objectFormat='sha1'] - Hash algorithm
 * @param {Array} opts.objects - Array of { type, id, size, data }
 * @param {object} [opts.refs] - { 'refs/heads/main': oid }
 * @param {string} [opts.head] - Branch HEAD should point at
 * @param {boolean} [opts.verifySizes=true] - Verify object sizes match
 */
async function toDisk(opts) {
  const {
    gitDir,
    objectFormat = 'sha1',
    objects,
    refs,
    head,
    fs = defaultFs,
    verifySizes = true
  } = opts

  if (!gitDir) throw new Error('gitDir is required')

  if (objectFormat !== 'sha1') {
    throw new Error('Only sha1 is supported')
  }

  if (!objects?.length) throw new Error('No objects supplied.')

  const dirs = await resolveGitDir(fs, gitDir)
  const objectsDir = join(dirs.common, 'objects')

  const unique = new Map()
  for (const o of objects) {
    if (!o.type || !o.id || o.data === null || o.data === undefined) {
      throw new Error('Invalid object entry: missing type/id/data')
    }
    if (verifySizes && o.data.length !== o.size) {
      throw new Error(
        `Size mismatch for ${o.type} ${o.id}: declared ${o.size}, buffer ${o.data.length}`
      )
    }
    unique.set(o.id, o)
  }

  if (unique.size < PACK_MIN_OBJECTS) {
    for (const o of unique.values()) await writeLoose(fs, objectsDir, o)
  } else {
    await writePack(fs, objectsDir, [...unique.values()])
  }

  if (refs) {
    for (const [refName, oid] of Object.entries(refs)) {
      await writeAtomic(fs, join(dirs.common, refName), b4a.from(oid.trim() + '\n'))
    }
  }

  if (head) {
    await writeAtomic(fs, join(dirs.git, 'HEAD'), b4a.from(`ref: refs/heads/${head}\n`))
  }
}

// `gitDir` may be a `.git` file (`gitdir: <path>`), and a linked worktree's
// git dir keeps objects and refs in the dir its `commondir` file names.
async function resolveGitDir(fs, gitDir) {
  const pointer = await readIfFile(fs, gitDir)
  const git = pointer === null ? gitDir : resolve(dirname(gitDir), pointer.replace(/^gitdir: /, ''))
  const common = await readIfFile(fs, join(git, 'commondir'))
  return { git, common: common === null ? git : resolve(git, common) }
}

async function readIfFile(fs, path) {
  try {
    return (await fs.readFile(path, 'utf8')).trim()
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null
    throw err
  }
}

function hashObject(o) {
  const header = b4a.from(`${o.type} ${o.data.length}\0`)
  const oid = crypto.createHash('sha1').update(header).update(o.data).digest('hex')
  if (oid !== o.id) {
    throw new Error(`OID mismatch for ${o.type}: expected ${o.id} but git computed ${oid}`)
  }
  return header
}

let tmpCount = 0

function tmpName(dir, kind) {
  return join(
    dir,
    `tmp_${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}_${tmpCount++}`
  )
}

async function writeAll(file, data) {
  for (let written = 0; written < data.byteLength;) {
    written += (await file.write(data, written, data.byteLength - written)).bytesWritten
  }
}

// Readers only ever see the whole file: it is written and synced under a
// temporary name in the same directory, then renamed into place.
async function writeAtomic(fs, path, data) {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true })
  const tmp = tmpName(dir, 'gip')
  const file = await fs.open(tmp, 'w')
  try {
    await writeAll(file, data)
    await file.datasync()
    await file.close()
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function writeLoose(fs, objectsDir, o) {
  const header = hashObject(o)
  const path = join(objectsDir, o.id.slice(0, 2), o.id.slice(2))
  try {
    await fs.stat(path)
    return
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  await writeAtomic(fs, path, zlib.deflateSync(b4a.concat([header, o.data])))
}

// One pack (version 2, no deltas) and its index (version 2), both renamed
// into place when complete. git only looks at a pack once its .idx exists.
async function writePack(fs, objectsDir, objects) {
  const dir = join(objectsDir, 'pack')
  await fs.mkdir(dir, { recursive: true })

  const tmp = tmpName(dir, 'pack')
  const file = await fs.open(tmp, 'w')
  const hash = crypto.createHash('sha1')
  const entries = []
  // Entries are copied into one write buffer as they come, so nothing of an
  // object outlives its turn but its index entry.
  const buffer = b4a.alloc(WRITE_BUFFER)
  let buffered = 0
  let offset = 0

  const flush = async () => {
    if (buffered === 0) return
    await writeAll(file, buffer.subarray(0, buffered))
    buffered = 0
  }
  const write = async (buf) => {
    hash.update(buf)
    offset += buf.byteLength
    if (buf.byteLength > buffer.byteLength - buffered) await flush()
    if (buf.byteLength >= buffer.byteLength) return writeAll(file, buf)
    buffer.set(buf, buffered)
    buffered += buf.byteLength
  }

  let checksum
  try {
    const header = b4a.alloc(12)
    header.write('PACK')
    header.writeUInt32BE(2, 4)
    header.writeUInt32BE(objects.length, 8)
    await write(header)

    for (const o of objects) {
      hashObject(o)
      const head = packEntryHeader(PACK_TYPES[o.type], o.data.length)
      const body = zlib.deflateSync(o.data)
      entries.push({ oid: o.id, offset, crc: crc32(body, crc32(head)) })
      await write(head)
      await write(body)
    }

    checksum = hash.digest()
    await flush()
    await writeAll(file, checksum)
    await file.datasync()
    await file.close()
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }

  const name = join(dir, 'pack-' + b4a.toString(checksum, 'hex'))
  await fs.rename(tmp, name + '.pack')
  await writeAtomic(fs, name + '.idx', packIndex(entries, checksum))
}

function packEntryHeader(type, size) {
  const bytes = []
  let byte = (type << 4) | (size % 16)
  size = Math.floor(size / 16)
  while (size > 0) {
    bytes.push(byte | 0x80)
    byte = size % 128
    size = Math.floor(size / 128)
  }
  bytes.push(byte)
  return b4a.from(bytes)
}

function packIndex(entries, packChecksum) {
  entries.sort((a, b) => (a.oid < b.oid ? -1 : 1))

  const n = entries.length
  const large = entries.filter((e) => e.offset >= 0x80000000)
  const idx = b4a.alloc(8 + 1024 + n * 28 + large.length * 8 + 40)
  idx.set([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2])

  const fanout = new Array(256).fill(0)
  for (const e of entries) fanout[parseInt(e.oid.slice(0, 2), 16)]++
  for (let i = 0, total = 0; i < 256; i++) {
    total += fanout[i]
    idx.writeUInt32BE(total, 8 + i * 4)
  }

  const oids = 8 + 1024
  const crcs = oids + n * 20
  const offsets = crcs + n * 4
  const larges = offsets + n * 4
  let nextLarge = 0

  for (let i = 0; i < n; i++) {
    const e = entries[i]
    idx.write(e.oid, oids + i * 20, 'hex')
    idx.writeUInt32BE(e.crc, crcs + i * 4)
    if (e.offset < 0x80000000) {
      idx.writeUInt32BE(e.offset, offsets + i * 4)
    } else {
      idx.writeUInt32BE(0x80000000 + nextLarge, offsets + i * 4)
      idx.writeUInt32BE(Math.floor(e.offset / 0x100000000), larges + nextLarge * 8)
      idx.writeUInt32BE(e.offset % 0x100000000, larges + nextLarge * 8 + 4)
      nextLarge++
    }
  }

  const end = larges + large.length * 8
  idx.set(packChecksum, end)
  idx.set(
    crypto
      .createHash('sha1')
      .update(idx.subarray(0, end + 20))
      .digest(),
    end + 20
  )
  return idx
}

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf, seed = 0) {
  let c = ~seed
  for (let i = 0; i < buf.byteLength; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

module.exports = {
  parseCommit,
  parseTag,
  walkTree,
  treeEntries,
  isUnsafeName,
  objectLinks,
  toDisk
}
