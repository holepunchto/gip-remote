// A single hypercore block can't exceed ~15 MiB. Git objects whose payload is
// larger than this are stored with an empty `data` in @gip/objects and their
// payload split across @gip/object-chunks rows, reassembled on read. Kept well
// under the block cap to leave headroom for record framing.
const OBJECT_CHUNK_SIZE = 8 * 1024 * 1024

async function putObject(db, oid, obj) {
  const data = obj.data || Buffer.alloc(0)

  // Fits in a single block — store inline, as before.
  if (data.byteLength <= OBJECT_CHUNK_SIZE) {
    await db.insert('@gip/objects', { oid, type: obj.type, size: obj.size, data })
    return
  }

  // Too big for one block — store an empty stub, then split the payload across
  // @gip/object-chunks rows. getObject stitches them back together.
  await db.insert('@gip/objects', { oid, type: obj.type, size: obj.size, data: Buffer.alloc(0) })

  let index = 0
  for (let start = 0; start < data.byteLength; start += OBJECT_CHUNK_SIZE) {
    await db.insert('@gip/object-chunks', {
      oid,
      index: index++,
      data: data.subarray(start, start + OBJECT_CHUNK_SIZE)
    })
  }
}

async function getObject(db, oid) {
  const record = await db.get('@gip/objects', { oid })
  if (!record) return null

  // A non-empty object with no inline data is chunked — stitch its payload back
  // together, in `index` order. A bare { oid } is ignored by the key-range
  // encoder, so scope explicitly to this oid's chunks with gte/lte.
  if (record.size > 0 && (!record.data || record.data.byteLength === 0)) {
    const parts = []
    const chunks = db.find('@gip/object-chunks', { gte: { oid }, lte: { oid } })
    for await (const chunk of chunks) parts.push(chunk.data)
    record.data = Buffer.concat(parts)
  }

  return record
}

// Yield an object's payload one buffer at a time — a single buffer for inline
// objects, or the chunk rows in order for large ones. Lets consumers stream a
// large object without buffering the whole thing in memory.
async function* objectStream(db, oid) {
  const record = await db.get('@gip/objects', { oid })
  if (!record) return

  if (record.size > 0 && (!record.data || record.data.byteLength === 0)) {
    const chunks = db.find('@gip/object-chunks', { gte: { oid }, lte: { oid } })
    for await (const chunk of chunks) yield chunk.data
    return
  }

  if (record.data && record.data.byteLength > 0) yield record.data
}

module.exports = { getObject, putObject, objectStream, OBJECT_CHUNK_SIZE }
