const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const env = require('bare-env')
const { createStore } = require('./helpers')
const Model = require('./helpers/model')
const git = require('./helpers/git')
const { KNOWN, bug, prng, generate, apply, compare } = require('./helpers/fuzz')
const { Remote } = require('..')

const iters = Number(env.GIP_FUZZ_ITERS || 1)
const first = env.GIP_SEED ? Number(env.GIP_SEED) : iters > 1 ? Date.now() % 2 ** 31 : 1

test(
  'replication: a reader that keeps losing its connections converges',
  { timeout: 0 },
  async (t) => {
    const { bootstrap } = await createTestnet(3, t.teardown)
    const stats = { drops: 0, observed: 0, moved: 0 }

    for (let i = 0; i < iters; i++) {
      if (!(await replicates(t, bootstrap, first + i, stats))) return
    }
    t.pass(`${iters} seed(s) from ${first}: ${JSON.stringify(stats)}`)
  }
)

bug('BUG: getRefObjects on a replica cancels every later read', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const writer = await createPeer(t, bootstrap, 'many-refs')

  const tips = []
  for (let i = 0; i < 300; i++) {
    const tree = git.tree([])
    const commit = git.commit({ tree: tree.oid, message: 'commit ' + i })
    await writer.remote.push('branch-' + i, commit.oid, git.toObjects([tree, commit]))
    tips.push(commit.oid)
  }

  const reader = await createPeer(t, bootstrap, writer.remote.url)
  await reader.remote.core.update({ wait: true })

  // REQUEST_CANCELLED today, here and on every read after it
  await t.execution(reader.remote.getRefObjects(tips[0]))
  await t.execution(reader.remote.getObject(tips[1]))
  await t.execution(reader.remote.getAllRefs())
})

async function replicates(t, bootstrap, seed, stats) {
  const rng = prng(seed)
  // No shallow pushes: every ref the writer holds then has its whole history,
  // so the reader must be able to fetch the complete closure of any ref it sees.
  const { universe, script } = generate(seed, { length: 60, mutationsOnly: true, shallow: 0 })
  const model = new Model(universe.meta)

  const writer = await createPeer(t, bootstrap, 'chaos-' + seed)
  const reader = await createPeer(t, bootstrap, writer.remote.url)

  let writing = true
  let failure = null

  const chaos = (async () => {
    while (writing) {
      await sleep(20 + rng.int(150))
      for (const conn of reader.swarm.connections) conn.destroy()
      stats.drops++
    }
  })()

  const observer = (async () => {
    while (writing && !failure) {
      try {
        for (const { ref, oid } of await reader.remote.getAllRefs()) {
          if (ref === 'HEAD') continue
          const ids = await fetchable(reader.remote, universe, oid)
          if (ids.length === 0) {
            // not a ref tip any more: the writer moved or deleted it meanwhile
            stats.moved++
            continue
          }
          stats.observed++
          const missing = universe.closure(oid).filter((o) => !ids.includes(o))
          if (missing.length > 0) {
            failure = `reader saw ${ref} at ${universe.label(oid)} without ${missing.map(universe.label)}`
          }
        }
      } catch (err) {
        failure = `a read on the reader threw: ${err.stack}`
      }
      await sleep(rng.int(20))
    }
  })()

  for (const op of script) {
    await apply(writer.remote, model, universe, op)
    await sleep(rng.int(15))
  }
  writing = false
  await Promise.all([chaos, observer])

  if (!failure) {
    const deadline = Date.now() + 30000
    for (;;) {
      const opts = { refObjects: !KNOWN.cancelledReads }
      failure = await compare(reader.remote, model, universe, opts).then(
        () => null,
        (err) => `reader did not converge: ${err.message}`
      )
      if (!failure || Date.now() > deadline) break
      await sleep(50)
    }
  }

  await reader.close()
  await writer.close()

  if (failure) t.fail(`GIP_SEED=${seed}: ${failure}`)
  return !failure
}

// The ids the reader can fetch for a ref tip. getRefObjects is the real path,
// but it breaks a replica for good (KNOWN.cancelledReads), so until that is
// fixed walk the same closure with getObject.
async function fetchable(remote, universe, oid) {
  if (!KNOWN.cancelledReads) return (await remote.getRefObjects(oid)).map((o) => o.id)

  const ids = []
  for (const id of universe.closure(oid)) {
    if (await remote.getObject(id)) ids.push(id)
  }
  return ids
}

async function createPeer(t, bootstrap, link) {
  const store = await createStore(t)
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => store.replicate(conn))

  const remote = new Remote(store, link)
  await remote.ready()
  swarm.join(remote.discoveryKey)
  await swarm.flush()

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await swarm.destroy()
    await remote.close()
    await store.close()
  }
  t.teardown(close, { order: -1 })

  return { remote, swarm, close }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
