const zlib = require('zlib')
const b4a = require('b4a')

// A single hypercore block can't exceed ~15 MiB. Git objects whose payload is
// larger than this are stored with a stub `data` in @gip/objects and their
// payload split across @gip/object-chunks rows, reassembled on read. Kept well
// under the block cap to leave headroom for record framing.
const OBJECT_CHUNK_SIZE = 8 * 1024 * 1024

// Object payloads are deflated at rest — git stores delta-compressed packs,
// so storing inflated bytes blows a repo up 5-20x. The @gip/objects struct is
// compact (can't gain fields), so compression is signalled without a schema
// change:
//   - inline: `size` is always the inflated length, so raw data has
//     byteLength === size and deflated data has byteLength < size (we only
//     store deflated when strictly smaller).
//   - chunked: the stub row's data is COMPRESSED_CHUNKS for per-chunk
//     deflated payloads, empty for raw chunks written by older versions.
const COMPRESSED_CHUNKS = Buffer.from([1])

// An object as it is stored: deflated when that's smaller, split into chunks
// when it is too big for one block. Kept apart from putObject so a push can
// deflate a batch and then insert it: zlib's scratch memory interleaved with
// the buffers a transaction holds until it flushes multiplied the memory of
// a large push.
function deflateObject(obj) {
  const data = obj.data || Buffer.alloc(0)
  const { type, size } = obj

  // Fits in a single block — store inline, deflated when that's smaller.
  if (data.byteLength <= OBJECT_CHUNK_SIZE) {
    const deflated = data.byteLength > 0 ? zlib.deflateRawSync(data) : data
    const stored = deflated.byteLength < data.byteLength ? compact(deflated) : data
    return { type, size, data: stored, chunks: null }
  }

  // Too big for one block — a stub marks deflated chunks, and the payload is
  // split and deflated per chunk. getObject stitches them back together.
  const chunks = []
  for (let start = 0; start < data.byteLength; start += OBJECT_CHUNK_SIZE) {
    chunks.push(zlib.deflateRawSync(data.subarray(start, start + OBJECT_CHUNK_SIZE)))
  }
  return { type, size, data: COMPRESSED_CHUNKS, chunks }
}

// A buffer straight from zlib, kept alive by the thousand, costs far more
// resident memory on Bare than its length. A copy doesn't.
function compact(buf) {
  const copy = b4a.alloc(buf.byteLength)
  copy.set(buf)
  return copy
}

async function putObject(db, oid, deflated) {
  const { type, size, data, chunks } = deflated
  await db.insert('@gip/objects', { oid, type, size, data })
  if (chunks === null) return

  for (let index = 0; index < chunks.length; index++) {
    await db.insert('@gip/object-chunks', { oid, index, data: chunks[index] })
  }
}

function isChunked(record) {
  return record.size > OBJECT_CHUNK_SIZE
}

function hasCompressedChunks(record) {
  return record.data && record.data.byteLength === 1 && record.data[0] === 1
}

async function getObject(db, oid) {
  const record = await db.get('@gip/objects', { oid })
  if (!record) return null

  if (isChunked(record)) {
    // A bare { oid } is ignored by the key-range encoder, so scope explicitly
    // to this oid's chunks with gte/lte.
    const compressed = hasCompressedChunks(record)
    const parts = []
    const chunks = db.find('@gip/object-chunks', { gte: { oid }, lte: { oid } })
    for await (const chunk of chunks) {
      parts.push(compressed ? zlib.inflateRawSync(chunk.data) : chunk.data)
    }
    record.data = Buffer.concat(parts)
  } else if (record.data && record.data.byteLength > 0 && record.data.byteLength < record.size) {
    record.data = zlib.inflateRawSync(record.data)
  }

  return record
}

// Yield an object's payload one buffer at a time — a single buffer for inline
// objects, or the chunk rows in order for large ones. Lets consumers stream a
// large object without buffering the whole thing in memory.
async function* objectStream(db, oid) {
  const record = await db.get('@gip/objects', { oid })
  if (!record) return

  if (isChunked(record)) {
    const compressed = hasCompressedChunks(record)
    const chunks = db.find('@gip/object-chunks', { gte: { oid }, lte: { oid } })
    for await (const chunk of chunks) {
      yield compressed ? zlib.inflateRawSync(chunk.data) : chunk.data
    }
    return
  }

  if (record.data && record.data.byteLength > 0) {
    yield record.data.byteLength < record.size ? zlib.inflateRawSync(record.data) : record.data
  }
}

module.exports = { getObject, deflateObject, putObject, objectStream, OBJECT_CHUNK_SIZE }
