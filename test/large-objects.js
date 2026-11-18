const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const { createRemote } = require('./helpers')

// A single hypercore block can't exceed ~15 MiB, so an object bigger than that
// used to fail the push with `BAD_ARGUMENT: Appended block exceeds the maximum
// suggested block size`. Large objects are now split across @gip/object-chunks
// rows and stitched back together on read. 20 MiB clears the cap and spans
// multiple 8 MiB chunks.
const BIG_SIZE = 20 * 1024 * 1024
const CHUNK_SIZE = 8 * 1024 * 1024

const OID_BIG_BLOB = 'a1'.repeat(20)
const OID_TREE = 'b2'.repeat(20)
const OID_COMMIT = 'c3'.repeat(20)

function makeBigBlob() {
  const data = Buffer.allocUnsafe(BIG_SIZE)
  // Deterministic, non-uniform fill so the round-trip check is meaningful.
  for (let i = 0; i < data.byteLength; i++) data[i] = (i * 31 + 7) % 251
  return data
}

function makeBigRepo() {
  const blob = makeBigBlob()

  const treeData = Buffer.concat([
    Buffer.from('100644 big.bin\0'),
    Buffer.from(OID_BIG_BLOB, 'hex')
  ])

  const commitData = Buffer.from(
    [
      `tree ${OID_TREE}`,
      'author Test User <test@test.com> 1700000000 +0000',
      'committer Test User <test@test.com> 1700000000 +0000',
      '',
      'big blob'
    ].join('\n')
  )

  const objects = new Map()
  objects.set(OID_BIG_BLOB, { type: 'blob', size: blob.byteLength, data: blob })
  objects.set(OID_TREE, { type: 'tree', size: treeData.byteLength, data: treeData })
  objects.set(OID_COMMIT, { type: 'commit', size: commitData.byteLength, data: commitData })

  return { objects, blob }
}

// The same commit over an empty tree, for tests that bring their own blobs
function makeEmptyRepo() {
  const { objects } = makeBigRepo()
  objects.delete(OID_BIG_BLOB)
  objects.set(OID_TREE, { type: 'tree', size: 0, data: Buffer.alloc(0) })
  return objects
}

async function countChunks(remote, oid) {
  let n = 0
  for await (const _ of remote._db.find('@gip/object-chunks', { gte: { oid }, lte: { oid } })) n++
  return n
}

test('push and read back an object larger than the block cap', async (t) => {
  const remote = await createRemote(t, { name: 'big-push' })
  const { objects, blob } = makeBigRepo()

  await remote.push('main', OID_COMMIT, objects)

  const got = await remote.getObject(OID_BIG_BLOB)
  t.ok(got, 'big blob stored')
  t.is(got.type, 'blob')
  t.is(got.size, BIG_SIZE, 'size preserved')
  t.is(got.data.byteLength, BIG_SIZE, 'full payload reassembled')
  t.ok(got.data.equals(blob), 'payload round-trips byte-for-byte')

  t.is(
    await countChunks(remote, OID_BIG_BLOB),
    Math.ceil(BIG_SIZE / CHUNK_SIZE),
    'took the chunk path'
  )
})

test('small objects in the same push stay inline (no chunk rows)', async (t) => {
  const remote = await createRemote(t, { name: 'big-mixed' })
  const { objects } = makeBigRepo()

  await remote.push('main', OID_COMMIT, objects)

  t.is(await countChunks(remote, OID_TREE), 0, 'tree is inline')
  t.is(await countChunks(remote, OID_COMMIT), 0, 'commit is inline')
})

test('multiple large objects reassemble independently (no cross-oid bleed)', async (t) => {
  const remote = await createRemote(t, { name: 'big-multi' })

  const blobA = Buffer.allocUnsafe(BIG_SIZE)
  blobA.fill(0xa1)
  const blobB = Buffer.allocUnsafe(BIG_SIZE + 1234) // different size too
  blobB.fill(0xb2)

  const OID_A = 'aa'.repeat(20)
  const OID_B = 'bb'.repeat(20)

  const objects = new Map()
  objects.set(OID_A, { type: 'blob', size: blobA.byteLength, data: blobA })
  objects.set(OID_B, { type: 'blob', size: blobB.byteLength, data: blobB })
  // A commit so push has a ref to resolve
  for (const [k, v] of makeEmptyRepo()) objects.set(k, v)

  await remote.push('main', OID_COMMIT, objects)

  const gotA = await remote.getObject(OID_A)
  const gotB = await remote.getObject(OID_B)
  t.ok(gotA.data.equals(blobA), 'A reassembles to exactly A')
  t.ok(gotB.data.equals(blobB), 'B reassembles to exactly B')
  t.is(gotA.data.byteLength, BIG_SIZE, 'A has A length')
  t.is(gotB.data.byteLength, BIG_SIZE + 1234, 'B has B length')
})

test('getRefObjects returns the large blob with full data', async (t) => {
  const remote = await createRemote(t, { name: 'big-ref' })
  const { objects, blob } = makeBigRepo()

  await remote.push('main', OID_COMMIT, objects)

  const results = await remote.getRefObjects(OID_COMMIT)
  t.is(results.length, objects.size, 'all objects returned')

  const big = results.find((r) => r.id === OID_BIG_BLOB)
  t.ok(big, 'large blob present')
  t.ok(big.data.equals(blob), 'large blob data intact')
})

test('re-pushing a large object is idempotent', async (t) => {
  const remote = await createRemote(t, { name: 'big-idempotent' })
  const { objects, blob } = makeBigRepo()

  await remote.push('main', OID_COMMIT, objects)
  await remote.push('main', OID_COMMIT, objects)

  const got = await remote.getObject(OID_BIG_BLOB)
  t.ok(got.data.equals(blob), 'payload still intact after re-push')
  t.is(
    await countChunks(remote, OID_BIG_BLOB),
    Math.ceil(BIG_SIZE / CHUNK_SIZE),
    'chunks not duplicated'
  )
})

test('a peer replicates and reads a large object over the swarm', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const r1 = await createRemote(t, { name: 'big-replicate', bootstrap })
  const { objects, blob } = makeBigRepo()
  await r1.push('main', OID_COMMIT, objects)

  const r2 = await createRemote(t, { link: r1.url, bootstrap })
  t.alike(r1.key, r2.key, 'same core')

  const got = await r2.getObject(OID_BIG_BLOB)
  t.ok(got, 'peer sees the large blob')
  t.is(got.data.byteLength, BIG_SIZE, 'peer reassembled full payload')
  t.ok(got.data.equals(blob), 'peer payload matches')
})

test('a large file reads back in full through the drive', async (t) => {
  const remote = await createRemote(t, { name: 'big-drive' })
  const { objects, blob } = makeBigRepo()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const viaGet = await drive.get('/big.bin')
  t.ok(viaGet.equals(blob), 'drive.get reassembles the chunked blob')

  const chunks = []
  for await (const chunk of drive.createReadStream('/big.bin')) chunks.push(chunk)
  t.ok(Buffer.concat(chunks).equals(blob), 'createReadStream reassembles the chunked blob')
})

test('object exactly at the chunk threshold stays inline', async (t) => {
  const remote = await createRemote(t, { name: 'boundary-inline' })

  const oid = '1a'.repeat(20)
  const data = Buffer.allocUnsafe(CHUNK_SIZE)
  data.fill(0x5a)
  const objects = makeEmptyRepo()
  objects.set(oid, { type: 'blob', size: data.byteLength, data })

  await remote.push('main', OID_COMMIT, objects)

  t.is(await countChunks(remote, oid), 0, 'no chunk rows at exactly the threshold')
  const got = await remote.getObject(oid)
  t.ok(got.data.equals(data), 'inline object round-trips')
})

test('object one byte over the threshold is chunked', async (t) => {
  const remote = await createRemote(t, { name: 'boundary-chunked' })

  const oid = '2b'.repeat(20)
  const data = Buffer.allocUnsafe(CHUNK_SIZE + 1)
  data.fill(0x6b)
  const objects = makeEmptyRepo()
  objects.set(oid, { type: 'blob', size: data.byteLength, data })

  await remote.push('main', OID_COMMIT, objects)

  t.is(await countChunks(remote, oid), 2, 'split into two chunks')
  const got = await remote.getObject(oid)
  t.ok(got.data.equals(data), 'chunked object round-trips')
})

test('empty blob stays inline and round-trips', async (t) => {
  const remote = await createRemote(t, { name: 'empty-blob' })

  const oid = '3c'.repeat(20)
  const objects = makeEmptyRepo()
  objects.set(oid, { type: 'blob', size: 0, data: Buffer.alloc(0) })

  await remote.push('main', OID_COMMIT, objects)

  t.is(await countChunks(remote, oid), 0, 'no chunk rows for an empty blob')
  const got = await remote.getObject(oid)
  t.is(got.size, 0, 'size is zero')
  t.ok(got.data === null || got.data.byteLength === 0, 'no payload')
})

test('getObject returns null for an unknown oid', async (t) => {
  const remote = await createRemote(t, { name: 'unknown-oid' })
  t.is(await remote.getObject('de'.repeat(20)), null)
})
