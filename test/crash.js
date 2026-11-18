const test = require('brittle')
const tmp = require('test-tmp')
const env = require('bare-env')
const { spawn } = require('child_process')
const { readFileSync, existsSync } = require('fs')
const { join } = require('path')
const Model = require('./helpers/model')
const { prng, generate, expect, compare, Sut } = require('./helpers/fuzz')

const WRITER = join(__dirname, 'fixtures', 'crash-writer.js')
const LENGTH = 160
const MAX_OPS_PER_RUN = 40

const iters = Number(env.GIP_FUZZ_ITERS || 1)
const first = env.GIP_SEED ? Number(env.GIP_SEED) : iters > 1 ? Date.now() % 2 ** 31 : 1

test(
  'crash: a SIGKILLed writer leaves the last acknowledged state, or the next one',
  { timeout: 0 },
  async (t) => {
    const stats = { kills: 0, midOp: 0, landed: 0 }
    for (let i = 0; i < iters; i++) {
      if (!(await crashes(t, first + i, stats))) return
    }
    t.pass(`${iters} seed(s) from ${first}: ${JSON.stringify(stats)}`)
  }
)

async function crashes(t, seed, stats) {
  const rng = prng(seed)
  const { universe, script } = generate(seed, { length: LENGTH, mutationsOnly: true })
  const root = await tmp(t)
  const dir = join(root, 'store')

  let model = new Model(universe.meta)
  let start = 0

  for (let round = 0; start < script.length; round++) {
    const log = join(root, `round-${round}.log`)
    const killAt = start + rng.int(MAX_OPS_PER_RUN)
    const delay = rng.int(10)
    const { code, signal } = await write([dir, log, seed, LENGTH, start], killAt, delay)
    if (!signal && code !== 0) {
      t.fail(`GIP_SEED=${seed} round ${round}: the writer exited with code ${code}`)
      return false
    }

    const progress = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    const last = (word) => {
      const line = progress.findLast((l) => l.startsWith(word))
      return line ? Number(line.split(' ')[1]) : start - 1
    }
    const done = last('done')
    const started = last('start')

    for (let i = start; i <= done; i++) expect(model, universe, script[i])
    const next = model.clone()
    if (started > done) expect(next, universe, script[started])
    // the next round is a new process
    model.reopen()
    next.reopen()

    if (signal) stats.kills++
    if (started > done) stats.midOp++

    const sut = new Sut(dir)
    await sut.open()
    try {
      const old = await compare(sut.remote, model, universe).catch((err) => err)
      if (!old) {
        start = done + 1
      } else if (
        started > done &&
        !(await compare(sut.remote, next, universe).catch((err) => err))
      ) {
        stats.landed++
        model = next
        start = started + 1
      } else {
        t.fail(
          `GIP_SEED=${seed} round ${round}: killed ${delay}ms after op ${killAt} began, ` +
            `acknowledged up to op ${done}, op ${started} in flight; the reopened store is ` +
            `neither state: ${old.message}`
        )
        return false
      }
    } finally {
      await sut.close()
    }
  }

  return true
}

// Run the writer until it starts op `killAt`, then SIGKILL it `delay` ms later.
function write(args, killAt, delay) {
  return new Promise((resolve) => {
    const child = spawn(Bare.argv[0], [WRITER, ...args.map(String)], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let timer = null

    child.stdout.on('data', (data) => {
      const indexes = data.toString().trim().split('\n').map(Number)
      if (timer === null && indexes.some((i) => i >= killAt)) {
        timer = setTimeout(() => child.kill('SIGKILL'), delay)
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}
