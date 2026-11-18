const test = require('brittle')
const b4a = require('b4a')
const { createStore } = require('./helpers')
const git = require('./helpers/git')
const { Remote } = require('..')
const { OBJECT_CHUNK_SIZE } = require('../lib/objects')

const SIZES = [
  ['chunk - 1', OBJECT_CHUNK_SIZE - 1],
  ['chunk', OBJECT_CHUNK_SIZE],
  ['chunk + 1', OBJECT_CHUNK_SIZE + 1],
  ['2 chunks - 1', 2 * OBJECT_CHUNK_SIZE - 1],
  ['2 chunks', 2 * OBJECT_CHUNK_SIZE],
  ['2 chunks + 1', 2 * OBJECT_CHUNK_SIZE + 1],
  ['3 chunks', 3 * OBJECT_CHUNK_SIZE]
]

for (const [label, size] of SIZES) {
  for (const kind of ['compressible', 'incompressible']) {
    test(`${kind} blob of ${label} bytes round-trips`, async (t) => {
      const remote = new Remote(await createStore(t), 'chunks')
      t.teardown(() => remote.close(), { order: -1 })
      await remote.ready()

      const data = kind === 'compressible' ? compressible(size) : incompressible(size)
      const blob = git.blob(data)
      const tree = git.tree([{ mode: '100644', name: 'big.bin', oid: blob.oid }])
      const commit = git.commit({ tree: tree.oid })
      await remote.push('main', commit.oid, git.toObjects([blob, tree, commit]))

      const got = await remote.getObject(blob.oid)
      t.is(got.size, size)
      t.ok(b4a.equals(got.data, data), 'getObject is byte-identical')

      const fetched = (await remote.getRefObjects(commit.oid)).find((o) => o.id === blob.oid)
      t.ok(b4a.equals(fetched.data, data), 'getRefObjects is byte-identical')

      const drive = await remote.toDrive('main')
      t.is((await drive.entry('/big.bin')).value.blob.byteLength, size)

      const parts = []
      for await (const part of drive.createReadStream('/big.bin')) parts.push(part)
      t.ok(b4a.equals(b4a.concat(parts), data), 'createReadStream is byte-identical')
      t.is(parts.length, Math.ceil(size / OBJECT_CHUNK_SIZE), 'one part per chunk')
    })
  }
}

function compressible(size) {
  const data = b4a.alloc(size)
  for (let i = 0; i < size; i++) data[i] = (i >> 10) & 0xff
  return data
}

function incompressible(size) {
  const words = new Uint32Array(Math.ceil(size / 4))
  let x = size | 1
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    words[i] = x
  }
  return b4a.from(words.buffer, 0, size)
}
