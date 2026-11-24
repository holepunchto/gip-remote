const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const z32 = require('z32')
const { createStore, makeTestObjects, OID_COMMIT } = require('./helpers')
const { Remote } = require('..')

const OID_COMMIT_2 = '11'.repeat(20)

function secondCommit(objects) {
  const next = new Map(objects)
  const text = [
    `tree ${'dd'.repeat(20)}`,
    `parent ${OID_COMMIT}`,
    'author Test User <test@test.com> 1700000001 +0000',
    'committer Test User <test@test.com> 1700000001 +0000',
    '',
    'second commit'
  ].join('\n')
  const data = Buffer.from(text)
  next.set(OID_COMMIT_2, { type: 'commit', size: data.length, data })
  return next
}

async function twoPushWriter(t, store) {
  const remote = new Remote(store.session(), 'my-repo')
  t.teardown(() => remote.close())
  await remote.ready()

  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const length = remote.core.length
  const pinned = link(remote.core.key, remote.core.fork, length)

  await remote.push('dev', OID_COMMIT_2, secondCommit(objects))

  return { remote, pinned, length }
}

function link(key, fork, length, name = 'my-repo') {
  return `git+pear://${fork}.${length}.${z32.encode(key)}/${name}`
}

test('pinned - resolves the pinned version, not latest', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  t.ok(writer.remote.core.length > writer.length, 'the log moved past the pin')

  const pinned = new Remote(store.session(), writer.pinned)
  t.teardown(() => pinned.close())
  await pinned.ready()

  t.is(pinned.pinned, true, 'reports itself pinned')
  t.alike(pinned.version, { fork: 0, length: writer.length })

  const names = (await pinned.getAllRefs()).map((r) => r.ref)
  t.ok(names.includes('refs/heads/main'), 'the branch inside the pin is there')
  t.absent(names.includes('refs/heads/dev'), 'the branch pushed after it is not')

  t.is(pinned.url, writer.pinned, 'url round-trips the link it was opened with')
})

test('pinned - an unversioned link follows latest', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  const latest = new Remote(store.session(), { name: 'my-repo', key: writer.remote.core.key })
  t.teardown(() => latest.close())
  await latest.ready()

  t.is(latest.pinned, false, 'not pinned')
  t.is(latest.version, null)
  t.is(latest.url, `git+pear://${z32.encode(writer.remote.core.key)}/my-repo`, 'url is unversioned')

  const names = (await latest.getAllRefs()).map((r) => r.ref)
  t.ok(names.includes('refs/heads/dev'), 'the branch pushed last is there')
})

test('pinned - the object link form carries the version', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  const pinned = new Remote(store.session(), {
    name: 'my-repo',
    key: writer.remote.core.key,
    fork: 0,
    length: writer.length
  })
  t.teardown(() => pinned.close())
  await pinned.ready()

  t.alike(pinned.version, { fork: 0, length: writer.length })

  const names = (await pinned.getAllRefs()).map((r) => r.ref)
  t.absent(names.includes('refs/heads/dev'), 'pinned before dev was pushed')
})

test('pinned - refuses writes', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  const pinned = new Remote(store.session(), writer.pinned)
  t.teardown(() => pinned.close())
  await pinned.ready()

  const objects = makeTestObjects()
  await t.exception(pinned.push('main', OID_COMMIT, objects), /pinned to 0\.\d+/)
  await t.exception(pinned.setHead('main'), /pinned to 0\.\d+/)
  await t.exception(pinned.deleteBranch('main'), /pinned to 0\.\d+/)
  await t.exception(pinned.deleteTag('v1'), /pinned to 0\.\d+/)
})

test('pinned - update() does not advance it', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  const pinned = new Remote(store.session(), writer.pinned)
  t.teardown(() => pinned.close())
  await pinned.ready()

  const before = await pinned.getAllRefs()

  await writer.remote.push('later', OID_COMMIT_2, secondCommit(makeTestObjects()))
  await pinned.update()

  t.alike(await pinned.getAllRefs(), before, 'the view did not move')
})

test('pinned - a length beyond the log is refused', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  const beyond = writer.remote.core.length + 10
  const remote = new Remote(store.session(), link(writer.remote.core.key, 0, beyond))

  await t.exception(remote.ready(), /Version not available/)
  await remote.close()
})

test('pinned - a fork mismatch is refused', async (t) => {
  const store = await createStore(t)
  const writer = await twoPushWriter(t, store)

  const remote = new Remote(store.session(), link(writer.remote.core.key, 1, writer.length))

  await t.exception(remote.ready(), /Fork mismatch/)
  await remote.close()
})

test('pinned - replicates nothing past the pin', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const writerStore = await createStore(t)
  const writerSwarm = new Hyperswarm({ bootstrap })
  t.teardown(() => writerSwarm.destroy())
  writerSwarm.on('connection', (conn) => writerStore.replicate(conn))

  const writer = await twoPushWriter(t, writerStore)
  const discovery = writerSwarm.join(writer.remote.discoveryKey)
  await discovery.flushed()

  const readerStore = await createStore(t)
  const readerSwarm = new Hyperswarm({ bootstrap })
  t.teardown(() => readerSwarm.destroy())
  readerSwarm.on('connection', (conn) => readerStore.replicate(conn))

  const core = readerStore.get({ key: writer.remote.core.key })
  t.teardown(() => core.close())
  await core.ready()
  readerSwarm.join(core.discoveryKey)
  await readerSwarm.flush()
  await core.update({ wait: true })

  const pinned = new Remote(readerStore.session(), writer.pinned)
  t.teardown(() => pinned.close())
  await pinned.ready()

  const names = (await pinned.getAllRefs()).map((r) => r.ref)
  t.ok(names.includes('refs/heads/main'), 'reads resolve from the peer')
  t.absent(names.includes('refs/heads/dev'), 'and stop at the pin')

  t.ok(core.length > writer.length, 'the reader knows the log is longer')
  t.absent(await core.has(writer.length), 'the first block past the pin was never fetched')
  t.ok(
    core.contiguousLength <= writer.length,
    `nothing downloaded past the pin (${core.contiguousLength} <= ${writer.length})`
  )
})
