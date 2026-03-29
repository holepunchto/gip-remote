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
  const { bootstrap } = await createTestnet(3, t.teardown)

  const store = await createStore(t)
  const swarm = new Hyperswarm({ bootstrap })
  t.teardown(() => swarm.destroy())

  swarm.on('connection', (conn) => {
    store.replicate(conn)
  })

  const remote = new Remote(store, opts.name ? opts.name : opts)
  t.teardown(() => remote.close())
  await remote.ready()

  return remote
}

module.exports = { createRemote }
