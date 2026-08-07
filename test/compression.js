const test = require('brittle')
const {
  createRemote,
  makeTestObjects,
  OID_COMMIT,
  OID_TREE_ROOT,
  OID_TREE_SRC
} = require('./helpers')

const OID_BLOB3 = '11'.repeat(20)
const OID_TREE_ROOT2 = '22'.repeat(20)
const OID_COMMIT2 = '33'.repeat(20)

function makeTreeData(entries) {
  const bufs = []
  for (const { mode, name, oid } of entries) {
    bufs.push(Buffer.from(`${mode} ${name}\0`))
    bufs.push(Buffer.from(oid, 'hex'))
  }
  return Buffer.concat(bufs)
}

test('compressible objects are deflated at rest and inflated on read', async (t) => {
  const remote = await createRemote(t, { name: 'compress' })

  const data = Buffer.from('aaaaaaaaaa'.repeat(500))
  const oid = '12'.repeat(20)
  const objects = new Map([[oid, { type: 'blob', size: data.length, data }]])
  objects.set(OID_TREE_ROOT, makeTestObjects().get(OID_TREE_ROOT))
  objects.set(OID_COMMIT, makeTestObjects().get(OID_COMMIT))

  await remote.push('main', OID_COMMIT, objects)

  const raw = await remote._db.get('@gip/objects', { oid })
  t.ok(raw.data.byteLength < data.length, 'stored smaller than the payload')

  const obj = await remote.getObject(oid)
  t.is(obj.size, data.length)
  t.alike(obj.data, data, 'round-trips to the original bytes')
})

test('incompressible objects stay raw', async (t) => {
  const remote = await createRemote(t, { name: 'raw' })

  // Deflate cannot shrink high-entropy bytes — the writer must keep them raw
  // so byteLength === size still signals "not compressed".
  const data = Buffer.from(
    Array.from({ length: 64 }, (_, i) => (i * 149 + ((i * i * 31) % 251)) % 256)
  )
  const oid = '34'.repeat(20)
  const objects = makeTestObjects()
  objects.set(oid, { type: 'blob', size: data.length, data })

  await remote.push('main', OID_COMMIT, objects)

  const raw = await remote._db.get('@gip/objects', { oid })
  t.is(raw.data.byteLength, data.length, 'stored as-is')
  t.alike((await remote.getObject(oid)).data, data)
})

test('raw records from older stores read back unchanged', async (t) => {
  const remote = await createRemote(t, { name: 'compat' })

  // Simulate a pre-compression store: raw payload inserted directly.
  const data = Buffer.from('plain old bytes, stored inflated')
  const oid = '56'.repeat(20)
  await remote._db.insert('@gip/objects', { oid, type: 'blob', size: data.length, data })
  await remote._db.flush()

  t.alike((await remote.getObject(oid)).data, data)
})

test('thin push resolves the tip and unchanged sub-trees from the store', async (t) => {
  const remote = await createRemote(t, { name: 'thin' })

  // Full first push.
  await remote.push('main', OID_COMMIT, makeTestObjects())

  // Second commit changes README.md only — the thin set carries just the new
  // blob, the new root tree and the new commit. src/ is not re-sent.
  const blob3 = Buffer.from('hello again')
  const rootTree2 = makeTreeData([
    { mode: '100644', name: 'README.md', oid: OID_BLOB3 },
    { mode: '40000', name: 'src', oid: OID_TREE_SRC }
  ])
  const commit2 = Buffer.from(
    [
      `tree ${OID_TREE_ROOT2}`,
      `parent ${OID_COMMIT}`,
      'author Test User <test@test.com> 1700000100 +0000',
      'committer Test User <test@test.com> 1700000100 +0000',
      '',
      'update readme'
    ].join('\n')
  )

  const thin = new Map([
    [OID_BLOB3, { type: 'blob', size: blob3.length, data: blob3 }],
    [OID_TREE_ROOT2, { type: 'tree', size: rootTree2.length, data: rootTree2 }],
    [OID_COMMIT2, { type: 'commit', size: commit2.length, data: commit2 }]
  ])

  await remote.push('main', OID_COMMIT2, thin)

  const ref = await remote.getBranchRef('main')
  t.is(ref.oid, OID_COMMIT2)

  // The file index must still see src/index.js even though its tree came
  // from the store, not the thin set.
  const files = await remote._db.find('@gip/files', {}).toArray()
  const paths = files.map((f) => f.path).sort()
  t.alike(paths, ['/README.md', '/src/index.js'])

  // A clone of the new head must get the full reachable set — the graph
  // walk reaches the old commit and its tree through the parent edge.
  const objs = await remote.getRefObjects(OID_COMMIT2)
  t.is(objs.length, 8)
})

test('chunked objects store deflated chunks behind the sentinel', async (t) => {
  const { OBJECT_CHUNK_SIZE } = require('../lib/objects')
  const remote = await createRemote(t, { name: 'chunked' })

  // Larger than one chunk and highly compressible — the chunks at rest must
  // be a fraction of the payload.
  const data = Buffer.alloc(OBJECT_CHUNK_SIZE + 1024 * 1024, 0x61)
  const oid = '78'.repeat(20)
  const objects = makeTestObjects()
  objects.set(oid, { type: 'blob', size: data.length, data })

  await remote.push('main', OID_COMMIT, objects)

  const stub = await remote._db.get('@gip/objects', { oid })
  t.is(stub.data.byteLength, 1, 'stub is the compressed-chunks sentinel')
  t.is(stub.data[0], 1)

  let storedBytes = 0
  const chunks = remote._db.find('@gip/object-chunks', { gte: { oid }, lte: { oid } })
  for await (const chunk of chunks) storedBytes += chunk.data.byteLength
  t.ok(storedBytes < data.length / 100, `at rest ${storedBytes} bytes for ${data.length}`)

  const obj = await remote.getObject(oid)
  t.is(obj.data.byteLength, data.length)
  t.alike(obj.data, data)
})

test('no-op push of an existing tip resolves the commit from the store', async (t) => {
  const remote = await createRemote(t, { name: 'noop' })

  await remote.push('main', OID_COMMIT, makeTestObjects())

  // Re-push the same tip with an empty thin set — everything already stored.
  await remote.push('main', OID_COMMIT, new Map())

  const ref = await remote.getBranchRef('main')
  t.is(ref.oid, OID_COMMIT)
  t.is((await remote.getRefObjects(OID_COMMIT)).length, 5)
})
