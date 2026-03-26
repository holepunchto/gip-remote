const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const b4a = require('b4a')
const z32 = require('z32')
const tmp = require('test-tmp')
const { Remote } = require('../..')

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

  swarm.on('connection', (conn) => {
    store.replicate(conn)
  })

  const key = z32.encode(b4a.alloc(32, 'test'))

  const remote = new Remote(store, `git+pear://${key}/${opts.name}`)
  t.teardown(() => remote.close())
  await remote.ready()

  return remote
}

module.exports = { createRemote }
