const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const { makeTestObjects, createRemote } = require('./helpers')

test('replicate', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const r1 = await createRemote(t, { name: 'r1', bootstrap })

  const objects = makeTestObjects()

  const oid = 'ee'.repeat(20)
  await r1.push('main', oid, objects)

  {
    const o = await r1.getObject(oid)
    t.is(o.oid, oid)
    t.is(o.size, 164)
  }

  const r2 = await createRemote(t, { link: r1.url, bootstrap })

  t.alike(r1.key, r2.key)

  t.is(r1.core.length, r2.core.length)

  {
    const o = await r2.getObject(oid)
    t.is(o.oid, oid)
    t.is(o.size, 164)
  }
})
