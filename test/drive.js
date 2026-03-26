const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const tmp = require('test-tmp')
const Corestore = require('corestore')

const { Remote } = require('../')

// --- Helpers ---

async function createStore(t) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  t.teardown(() => store.close())
  return store
}

async function createRemote(t, opts = {}) {
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

const OID_BLOB1 = 'aa'.repeat(20)
const OID_BLOB2 = 'bb'.repeat(20)
const OID_BLOB3 = 'ff'.repeat(20)
const OID_TREE_SRC = 'cc'.repeat(20)
const OID_TREE_ROOT = 'dd'.repeat(20)
const OID_COMMIT = 'ee'.repeat(20)

function makeTreeData(entries) {
  const bufs = []
  for (const { mode, name, oid } of entries) {
    bufs.push(Buffer.from(`${mode} ${name}\0`))
    bufs.push(Buffer.from(oid, 'hex'))
  }
  return Buffer.concat(bufs)
}

function makeTestObjects() {
  const objects = new Map()

  const blobData = Buffer.from('hello world')
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

// Expanded tree with executable file and deeper nesting
function makeExpandedObjects() {
  const objects = makeTestObjects()

  const blob3Data = Buffer.from('#!/bin/sh\necho hi')
  objects.set(OID_BLOB3, { type: 'blob', size: blob3Data.length, data: blob3Data })

  // Replace src tree: index.js + run.sh (executable)
  const srcTreeData = makeTreeData([
    { mode: '100644', name: 'index.js', oid: OID_BLOB2 },
    { mode: '100755', name: 'run.sh', oid: OID_BLOB3 }
  ])
  objects.set(OID_TREE_SRC, { type: 'tree', size: srcTreeData.length, data: srcTreeData })

  // Update root tree
  const rootTreeData = makeTreeData([
    { mode: '100644', name: 'README.md', oid: OID_BLOB1 },
    { mode: '40000', name: 'src', oid: OID_TREE_SRC }
  ])
  objects.set(OID_TREE_ROOT, { type: 'tree', size: rootTreeData.length, data: rootTreeData })

  // Recompute commit (same tree OID since we replaced in place)
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

async function pushAndGetDrive(t, name, objects) {
  const remote = await createRemote(t, { name })
  objects = objects || makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)
  const drive = await remote.toDrive('main')
  t.ok(drive, 'drive created')
  return drive
}

// --- Tests ---

test('drive get returns null for missing file', async (t) => {
  const drive = await pushAndGetDrive(t, 'get-missing')
  const result = await drive.get('/nonexistent.txt')
  t.is(result, null)
})

test('drive get reads nested file content', async (t) => {
  const drive = await pushAndGetDrive(t, 'get-nested')
  const content = await drive.get('/src/index.js')
  t.is(content.toString(), 'console.log("hi")')
})

test('drive entry accepts entry object', async (t) => {
  const drive = await pushAndGetDrive(t, 'entry-object')

  const entry = await drive.entry({ key: '/README.md' })
  t.ok(entry)
  t.is(entry.key, '/README.md')
  t.is(entry.value.blob.byteLength, 11)
})

test('drive entry detects executable mode', async (t) => {
  const drive = await pushAndGetDrive(t, 'entry-exec', makeExpandedObjects())

  const entry = await drive.entry('/src/run.sh')
  t.ok(entry)
  t.is(entry.value.executable, true)

  const regular = await drive.entry('/src/index.js')
  t.is(regular.value.executable, false)
})

test('drive createReadStream reads content', async (t) => {
  const drive = await pushAndGetDrive(t, 'read-stream')

  const chunks = []
  for await (const chunk of drive.createReadStream('/README.md')) {
    chunks.push(chunk)
  }

  const content = Buffer.concat(chunks).toString()
  t.is(content, 'hello world')
})

test('drive createReadStream accepts entry object', async (t) => {
  const drive = await pushAndGetDrive(t, 'read-stream-entry')

  const chunks = []
  for await (const chunk of drive.createReadStream({ key: '/src/index.js' })) {
    chunks.push(chunk)
  }

  t.is(Buffer.concat(chunks).toString(), 'console.log("hi")')
})

test('drive list with subfolder', async (t) => {
  const drive = await pushAndGetDrive(t, 'list-sub')

  const paths = []
  for await (const path of drive.list('/src')) {
    paths.push(path)
  }

  t.ok(paths.includes('/src/index.js'), 'has src/index.js')
  t.is(paths.filter((p) => p.startsWith('/README')).length, 0, 'no root files')
})

test('drive list with ignore filter', async (t) => {
  const drive = await pushAndGetDrive(t, 'list-ignore')

  const paths = []
  for await (const path of drive.list('/', { ignore: (p) => p.endsWith('.md') })) {
    paths.push(path)
  }

  t.is(paths.filter((p) => p.endsWith('.md')).length, 0, 'md files filtered')
  t.ok(paths.includes('/src/index.js'), 'non-ignored files included')
})

test('drive readdir on subfolder', async (t) => {
  const drive = await pushAndGetDrive(t, 'readdir-sub', makeExpandedObjects())

  const entries = []
  for await (const name of drive.readdir('/src')) {
    entries.push(name)
  }

  t.ok(entries.includes('index.js'), 'has index.js')
  t.ok(entries.includes('run.sh'), 'has run.sh')
  t.is(entries.length, 2)
})

test('drive list returns all files with expanded tree', async (t) => {
  const drive = await pushAndGetDrive(t, 'list-expanded', makeExpandedObjects())

  const paths = []
  for await (const path of drive.list('/')) {
    paths.push(path)
  }

  t.ok(paths.includes('/README.md'))
  t.ok(paths.includes('/src/index.js'))
  t.ok(paths.includes('/src/run.sh'))
  t.is(paths.length, 3)
})
