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

// An inline object as it is stored: deflated when that's smaller. Kept apart
// from the insert so a push can deflate a batch and then insert it: zlib's
// scratch memory interleaved with the buffers a transaction holds until it
// flushes multiplied the memory of a large push.
function deflateInline(data) {
  const deflated = data.byteLength > 0 ? zlib.deflateRawSync(data) : data
  return deflated.byteLength < data.byteLength ? compact(deflated) : data
}

// A buffer straight from zlib, kept alive by the thousand, costs far more
// resident memory on Bare than its length. A copy doesn't.
function compact(buf) {
  const copy = b4a.alloc(buf.byteLength)
  copy.set(buf)
  return copy
}

// Regroup buffers of any size into buffers of exactly `size` (the last one
// may be shorter).
async function* resize(parts, size) {
  let pending = []
  let bytes = 0

  for await (let part of parts) {
    while (bytes + part.byteLength >= size) {
      const take = size - bytes
      pending.push(part.subarray(0, take))
      yield pending.length === 1 ? pending[0] : b4a.concat(pending)
      pending = []
      bytes = 0
      part = part.subarray(take)
    }
    if (part.byteLength > 0) {
      pending.push(part)
      bytes += part.byteLength
    }
  }

  if (bytes > 0) yield pending.length === 1 ? pending[0] : b4a.concat(pending)
}

// The payload of `obj` as buffers: its `data`, or its `chunks` when it comes
// as a stream.
function parts(obj) {
  return obj.chunks || [obj.data || b4a.alloc(0)]
}

// Write an object too big for one block: its payload, split and deflated per
// chunk, then the stub row that makes it exist. `flush` is called after each
// chunk so only one is ever held; the stub goes last, so a writer that dies
// half way leaves rows nothing points at.
async function putChunked(db, oid, obj, flush) {
  let index = 0
  for await (const chunk of resize(parts(obj), OBJECT_CHUNK_SIZE)) {
    await db().insert('@gip/object-chunks', {
      oid,
      index: index++,
      data: zlib.deflateRawSync(chunk)
    })
    await flush()
  }

  await db().insert('@gip/objects', {
    oid,
    type: obj.type,
    size: obj.size,
    data: COMPRESSED_CHUNKS
  })
}

function isChunked(record) {
  return record.size > OBJECT_CHUNK_SIZE
}

function hasCompressedChunks(record) {
  return record.data && record.data.byteLength === 1 && record.data[0] === 1
}

// The chunks of a large object, in order. Read row by row, never through a
// db stream: a consumer that stops early would destroy the stream, and with
// it every other read on the db.
function chunksOf(db, record) {
  const compressed = hasCompressedChunks(record)
  const { oid } = record

  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; ; index++) {
        const chunk = await db.get('@gip/object-chunks', { oid, index })
        if (chunk === null) return
        yield compressed ? zlib.inflateRawSync(chunk.data) : chunk.data
      }
    }
  }
}

function inflateInline(record) {
  const { data, size } = record
  if (data && data.byteLength > 0 && data.byteLength < size) return zlib.inflateRawSync(data)
  return data
}

// { oid, type, size, data }, or null. A large object has `chunks`, an async
// iterable of buffers, instead of `data`: nothing of it is read yet.
async function readObject(db, oid) {
  const record = await db.get('@gip/objects', { oid })
  if (!record) return null

  if (isChunked(record)) {
    record.chunks = chunksOf(db, record)
    record.data = null
  } else {
    record.data = inflateInline(record)
  }

  return record
}

// readObject with a large object's chunks joined into `data`
async function getObject(db, oid) {
  const record = await readObject(db, oid)
  if (record && record.chunks) await join(record)
  return record
}

async function join(obj) {
  const parts = []
  for await (const chunk of obj.chunks) parts.push(chunk)
  obj.data = b4a.concat(parts)
  delete obj.chunks
  return obj
}

// Yield an object's payload one buffer at a time — a single buffer for inline
// objects, or the chunk rows in order for large ones. Lets consumers stream a
// large object without buffering the whole thing in memory.
async function* objectStream(db, oid) {
  const record = await readObject(db, oid)
  if (!record) return

  if (record.chunks) yield* record.chunks
  else if (record.data && record.data.byteLength > 0) yield record.data
}

module.exports = {
  getObject,
  readObject,
  join,
  parts,
  deflateInline,
  putChunked,
  objectStream,
  OBJECT_CHUNK_SIZE
}
