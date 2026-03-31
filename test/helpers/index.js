const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const { Remote } = require('../..')

async function createStore(t) {
  const dir = await tmp(t)
  const store = new Corestore(dir)
  t.teardown(() => store.close())
  return store
}

async function createRemote(t, opts = {}) {
  if (!opts.bootstrap) {
    const { bootstrap } = await createTestnet(3, t.teardown)
    opts.bootstrap = bootstrap
  }

  const store = await createStore(t)
  const swarm = new Hyperswarm({ bootstrap: opts.bootstrap })
  t.teardown(() => swarm.destroy())

  swarm.on('connection', (conn) => {
    store.replicate(conn)
  })

  const _opts = opts.name || opts.link || opts
  const remote = new Remote(store, _opts)
  t.teardown(() => remote.close())
  await remote.ready()

  const discovery = swarm.join(remote.discoveryKey)
  await discovery.flushed()
  await swarm.flush()

  if (!remote.core.writable) {
    await remote.core.update({ wait: true })
  }

  return remote
}

// 40-char hex OIDs (proper SHA1 length)
const OID_BLOB1 = 'aa'.repeat(20)
const OID_BLOB2 = 'bb'.repeat(20)
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

module.exports = {
  createStore,
  createRemote,
  makeTestObjects,
  OID_BLOB1,
  OID_BLOB2,
  OID_COMMIT,
  OID_TREE_ROOT,
  OID_TREE_SRC
}
