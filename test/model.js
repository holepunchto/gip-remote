const test = require('brittle')
const tmp = require('test-tmp')
const env = require('bare-env')
const { spawnSync } = require('child_process')
const { join } = require('path')
const { toDisk } = require('../lib/git')
const { createStore } = require('./helpers')
const git = require('./helpers/git')
const { generate, fuzz } = require('./helpers/fuzz')
const { Remote } = require('..')

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]

test('generated object graphs are valid git', async (t) => {
  const { universe } = generate(1)
  const dir = await tmp(t)
  spawnSync('git', ['init', '-q'], { cwd: dir })

  const objects = [...universe.objects].map(([id, obj]) => ({ id, ...obj }))
  const refs = {}
  universe.commits.forEach((oid, i) => (refs['refs/heads/c' + i] = oid))
  universe.tags.forEach((oid, i) => (refs['refs/tags/t' + i] = oid))
  await toDisk({ gitDir: join(dir, '.git'), objects, refs })

  const fsck = spawnSync('git', ['fsck', '--strict', '--no-dangling'], { cwd: dir })
  t.is(fsck.status, 0, fsck.stderr.toString())
})

if (env.GIP_FUZZ_ITERS) {
  test('model: long fuzz', { timeout: 0 }, async (t) => {
    const iters = Number(env.GIP_FUZZ_ITERS)
    const first = env.GIP_SEED ? Number(env.GIP_SEED) : Date.now() % 2 ** 31
    const started = Date.now()

    for (let i = 0; i < iters; i++) {
      if (!(await fuzz(t, first + i, { length: 60 }))) return
    }
    t.pass(`seeds ${first}..${first + iters - 1} in ${Date.now() - started}ms`)
  })
} else {
  for (const seed of env.GIP_SEED ? [Number(env.GIP_SEED)] : SEEDS) {
    test(`model: random ops match the model, seed ${seed}`, async (t) => {
      if (await fuzz(t, seed)) t.pass()
    })
  }
}

test('a thin push indexes the size of files whose blob it did not carry', async (t) => {
  const remote = await create(t)
  const blob = git.blob('hello')
  const tree = git.tree([{ mode: '100644', name: 'a.txt', oid: blob.oid }])
  const commit = git.commit({ tree: tree.oid })

  await remote.push('main', commit.oid, git.toObjects([blob, tree, commit]))
  // git push origin main:release sends nothing, the remote has it all
  await remote.push('release', commit.oid, new Map())

  const drive = await remote.toDrive('release')
  t.is((await drive.entry('/a.txt')).value.blob.byteLength, 5)
})

test('list and readdir of a folder include names starting beyond U+FFFF', async (t) => {
  const remote = await create(t)
  const blob = git.blob('hello')
  const dir = git.tree([{ mode: '100644', name: '😀.txt', oid: blob.oid }])
  const tree = git.tree([{ mode: '40000', name: 'docs', oid: dir.oid }])
  const commit = git.commit({ tree: tree.oid })
  await remote.push('main', commit.oid, git.toObjects([blob, dir, tree, commit]))

  const drive = await remote.toDrive('main')
  const listed = []
  for await (const entry of drive.list('/docs')) listed.push(entry.key)
  const names = []
  for await (const name of drive.readdir('/docs')) names.push(name)

  t.alike(listed, ['/docs/😀.txt'])
  t.alike(names, ['😀.txt'])
})

test('push rejects a ref whose tree and blobs are in neither the push nor the store', async (t) => {
  const remote = await create(t)
  const blob = git.blob('never sent')
  const tree = git.tree([{ mode: '100644', name: 'a.txt', oid: blob.oid }])
  const commit = git.commit({ tree: tree.oid })

  const err = await remote.push('main', commit.oid, git.toObjects([commit])).catch((err) => err)
  t.is(err.code, 'MISSING_OBJECTS')
  t.alike(err.missing, [tree.oid])
  t.alike(await remote.getAllRefs(), [], 'no ref without its objects')
  t.is(await remote.getRefObjects(commit.oid).then((objs) => objs.length), 0, 'nothing to fetch')

  await remote.push('main', commit.oid, git.toObjects([blob, tree, commit]))
  t.is((await remote.getBranchRef('main')).oid, commit.oid, 'lands once complete')
})

test('push rejects a commit whose parent is missing, as from a shallow clone', async (t) => {
  const remote = await create(t)
  const tree = git.tree([])
  const parent = git.commit({ tree: tree.oid, message: 'parent' })
  const commit = git.commit({ tree: tree.oid, parents: [parent.oid] })

  const err = await remote.push('main', commit.oid, git.toObjects([tree, commit])).catch((e) => e)
  t.is(err.code, 'MISSING_OBJECTS')
  t.alike(err.missing, [parent.oid])
  t.alike(await remote.getAllRefs(), [])
})

test('a submodule commit is not part of the closure', async (t) => {
  const remote = await create(t)
  const tree = git.tree([{ mode: '160000', name: 'sub', oid: 'ab'.repeat(20) }])
  const commit = git.commit({ tree: tree.oid })

  await remote.push('main', commit.oid, git.toObjects([tree, commit]))
  const objs = await remote.getRefObjects(commit.oid)
  t.alike(objs.map((o) => o.id).sort(), [tree.oid, commit.oid].sort())
})

async function create(t) {
  const remote = new Remote(await createStore(t), 'bugs')
  t.teardown(() => remote.close(), { order: -1 })
  await remote.ready()
  return remote
}
