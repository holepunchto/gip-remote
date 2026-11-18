const test = require('brittle')
const tmp = require('test-tmp')
const { spawnSync } = require('child_process')
const { join } = require('path')

const FIXTURE = join(__dirname, 'fixtures', 'stream-repo.js')
const SMALL = 5000
const LARGE = 50000
// What an object may add to the peak. Held in one transaction an object cost
// 27 KiB; streamed it measures about 6.
const PER_OBJECT = 12 * 1024

test(
  'memory of a streamed push and clone stays bounded per object',
  { timeout: 120000 },
  async (t) => {
    const small = await run(t, SMALL)
    const large = await run(t, LARGE)

    t.is(small.objects, SMALL + 2)
    t.is(large.objects, LARGE + 2, 'the clone is whole')

    const perObject = (large.peak - small.peak) / (LARGE - SMALL)
    t.ok(perObject < PER_OBJECT, `${Math.round(perObject)} bytes of peak memory per object`)
    t.comment(`peak ${mb(small.peak)} MB at ${SMALL} files, ${mb(large.peak)} MB at ${LARGE}`)
  }
)

async function run(t, count) {
  const dir = await tmp(t)
  const result = spawnSync(Bare.argv[0], [FIXTURE, dir, String(count)])
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString())
}

function mb(bytes) {
  return Math.round(bytes / 1024 / 1024)
}
