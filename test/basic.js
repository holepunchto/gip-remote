const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const tmp = require('test-tmp')
const Corestore = require('corestore')

const { Remote, parseCommit, walkTree } = require('../')

// --- Helpers ---

async function createStore (t) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  t.teardown(() => store.close())
  return store
}

async function createRemote (t, opts = {}) {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const store = await createStore(t)
  const swarm = new Hyperswarm({ bootstrap })
  t.teardown(() => swarm.destroy())

  const remote = new Remote({
    name: opts.name || 'test-repo',
    store,
    swarm,
    ...opts
  })
  t.teardown(() => remote.close())
  await remote.ready()

  return remote
}

// 40-char hex OIDs (proper SHA1 length)
const OID_BLOB1 = 'aa'.repeat(20)
const OID_BLOB2 = 'bb'.repeat(20)
const OID_TREE_SRC = 'cc'.repeat(20)
const OID_TREE_ROOT = 'dd'.repeat(20)
const OID_COMMIT = 'ee'.repeat(20)

function makeTreeData (entries) {
  const bufs = []
  for (const { mode, name, oid } of entries) {
    bufs.push(Buffer.from(`${mode} ${name}\0`))
    bufs.push(Buffer.from(oid, 'hex'))
  }
  return Buffer.concat(bufs)
}

function makeTestObjects () {
  const blobData = Buffer.from('hello world')
  const objects = new Map()
  objects.set(OID_BLOB1, { type: 'blob', size: blobData.length, data: blobData })

  const blob2Data = Buffer.from('console.log("hi")')
  objects.set(OID_BLOB2, { type: 'blob', size: blob2Data.length, data: blob2Data })

  const srcTreeData = makeTreeData([{ mode: '100644', name: 'index.js', oid: OID_BLOB2 }])
  objects.set(OID_TREE_SRC, { type: 'tree', size: srcTreeData.length, data: srcTreeData })

  const rootTreeData = makeTreeData([
    { mode: '100644', name: 'README.md', oid: OID_BLOB1 },
    { mode: '40000', name: 'src', oid: OID_TREE_SRC }
  ])
  objects.set(OID_TREE_ROOT, { type: 'tree', size: rootTreeData.length, data: rootTreeData })

  const commitText = [
    `tree ${OID_TREE_ROOT}`,
    'author Test User <test@test.com> 1700000000 +0000',
    'committer Test User <test@test.com> 1700000000 +0000',
    '',
    'initial commit'
  ].join('\n')
  const commitData = Buffer.from(commitText)
  objects.set(OID_COMMIT, { type: 'commit', size: commitData.length, data: commitData })

  return objects
}

// --- parseCommit ---

test('parseCommit extracts metadata', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'parent def456',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Bob <bob@example.com> 1700000001 +0000',
      '',
      'Fix the thing',
      '',
      'More details here.'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.is(commit.tree, 'abc123')
  t.alike(commit.parents, ['def456'])
  t.is(commit.author, 'Alice')
  t.is(commit.timestamp, 1700000000)
  t.is(commit.message, 'Fix the thing\n\nMore details here.')
})

test('parseCommit handles no parent', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Alice <alice@example.com> 1700000000 +0000',
      '',
      'initial'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.is(commit.tree, 'abc123')
  t.alike(commit.parents, [])
  t.is(commit.message, 'initial')
})

test('parseCommit handles multiple parents (merge commit)', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'parent def456',
      'parent 789abc',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Alice <alice@example.com> 1700000000 +0000',
      '',
      'merge branch'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.alike(commit.parents, ['def456', '789abc'])
  t.is(commit.message, 'merge branch')
})

// --- walkTree ---

test('walkTree enumerates all files', (t) => {
  const objects = makeTestObjects()
  const files = walkTree(objects, OID_TREE_ROOT, '')

  t.is(files.length, 2)

  const readme = files.find((f) => f.path === '/README.md')
  t.ok(readme, 'found README.md')
  t.is(readme.oid, OID_BLOB1)
  t.is(readme.size, 11)

  const index = files.find((f) => f.path === '/src/index.js')
  t.ok(index, 'found src/index.js')
  t.is(index.oid, OID_BLOB2)
})

test('walkTree returns empty for missing tree', (t) => {
  const objects = new Map()
  const files = walkTree(objects, 'deadbeef'.repeat(5), '')
  t.is(files.length, 0)
})

// --- Remote ---

test('remote has key after ready', async (t) => {
  const remote = await createRemote(t)
  t.ok(remote.key, 'has key')
  t.ok(remote.discoveryKey, 'has discoveryKey')
  t.is(remote.name, 'test-repo')
})

test('push stores objects and branch', async (t) => {
  const remote = await createRemote(t, { name: 'push-test' })
  const objects = makeTestObjects()

  await remote.push('main', OID_COMMIT, objects)

  // Check branch
  const refs = await remote.getAllRefs()
  const main = refs.find((r) => r.ref === 'refs/heads/main')
  t.ok(main, 'main branch exists')
  t.is(main.oid, OID_COMMIT)

  // Check HEAD synthesized
  const head = refs.find((r) => r.ref === 'HEAD')
  t.ok(head, 'HEAD exists')
  t.is(head.oid, OID_COMMIT)

  // Check object retrieval
  const blob = await remote.getObject(OID_BLOB1)
  t.ok(blob, 'blob stored')
  t.is(blob.type, 'blob')
  t.is(blob.data.toString(), 'hello world')
})

test('getBranchRef returns null for missing branch', async (t) => {
  const remote = await createRemote(t, { name: 'missing-branch' })
  const ref = await remote.getBranchRef('nonexistent')
  t.is(ref, null)
})

test('getBranchRef returns ref after push', async (t) => {
  const remote = await createRemote(t, { name: 'ref-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const ref = await remote.getBranchRef('main')
  t.ok(ref)
  t.is(ref.ref, 'refs/heads/main')
  t.is(ref.oid, OID_COMMIT)
})

test('getRefObjects returns all objects for a commit', async (t) => {
  const remote = await createRemote(t, { name: 'ref-objects' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const results = await remote.getRefObjects(OID_COMMIT)
  t.is(results.length, objects.size)

  const ids = results.map((r) => r.id)
  for (const oid of objects.keys()) {
    t.ok(ids.includes(oid), `has ${oid.slice(0, 8)}...`)
  }
})

test('push is idempotent for objects', async (t) => {
  const remote = await createRemote(t, { name: 'idempotent' })
  const objects = makeTestObjects()

  await remote.push('main', OID_COMMIT, objects)
  await remote.push('main', OID_COMMIT, objects)

  const blob = await remote.getObject(OID_BLOB1)
  t.ok(blob, 'blob still exists')
  t.is(blob.data.toString(), 'hello world')
})

// --- Drive ---

test('toDrive returns null for missing branch', async (t) => {
  const remote = await createRemote(t, { name: 'no-drive' })
  const drive = await remote.toDrive('main')
  t.is(drive, null)
})

test('toDrive lists files and reads content', async (t) => {
  const remote = await createRemote(t, { name: 'drive-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')
  t.ok(drive, 'drive created')

  const paths = []
  for await (const path of drive.list('/')) {
    paths.push(path)
  }

  t.ok(paths.includes('/README.md'), 'has README.md')
  t.ok(paths.includes('/src/index.js'), 'has src/index.js')
  t.is(paths.length, 2)

  const content = await drive.get('/README.md')
  t.is(content.toString(), 'hello world')
})

test('drive entry returns correct metadata', async (t) => {
  const remote = await createRemote(t, { name: 'entry-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const entry = await drive.entry('/README.md')
  t.ok(entry, 'entry found')
  t.is(entry.key, '/README.md')
  t.is(entry.value.blob.byteLength, 11)
  t.is(entry.value.executable, false)

  const missing = await drive.entry('/nope.txt')
  t.is(missing, null, 'missing entry returns null')
})

test('drive readdir returns immediate children', async (t) => {
  const remote = await createRemote(t, { name: 'readdir-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const rootEntries = []
  for await (const name of drive.readdir('/')) {
    rootEntries.push(name)
  }

  t.ok(rootEntries.includes('README.md'), 'has README.md')
  t.ok(rootEntries.includes('src'), 'has src dir')
  t.is(rootEntries.length, 2)
})
