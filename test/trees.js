const test = require('brittle')
const tmp = require('test-tmp')
const b4a = require('b4a')
const { spawnSync } = require('child_process')
const { createStore } = require('./helpers')
const git = require('./helpers/git')
const { toDisk } = require('../lib/git')
const { Remote } = require('..')

// Modes old gits wrote and git still reads: group-writable files, a tree
// mode with a leading zero. From libgit2's deprecated-mode.git and git v1.0.0.
test('trees with legacy entry modes round-trip byte-identically', async (t) => {
  const remote = await create(t)
  const blob = git.blob('hello')
  const sub = git.tree([
    { mode: '100664', name: 'group-writable.txt', oid: blob.oid },
    { mode: '100640', name: 'private.txt', oid: blob.oid },
    { mode: '100775', name: 'run.sh', oid: blob.oid }
  ])
  // git.tree only sorts sub-trees right when their mode is 40000: one entry
  const tree = git.tree([{ mode: '040000', name: 'dir', oid: sub.oid }])
  const commit = git.commit({ tree: tree.oid })
  const all = [blob, sub, tree, commit]

  await remote.push('main', commit.oid, git.toObjects(all))
  await remote.push('tags/v1', commit.oid, new Map())

  const objects = await remote.getRefObjects(commit.oid)
  t.alike(objects.map((o) => o.id).sort(), all.map((o) => o.oid).sort())
  for (const obj of all) {
    t.ok(b4a.equals(objects.find((o) => o.id === obj.oid).data, obj.data), obj.type + ' bytes')
  }

  for (const name of ['refs/heads/main', 'refs/tags/v1']) {
    const drive = await remote.toDrive(name)
    const listed = []
    for await (const entry of drive.list('/')) listed.push([entry.key, entry.value.executable])
    t.alike(
      listed.sort(),
      [
        ['/dir/group-writable.txt', false],
        ['/dir/private.txt', false],
        ['/dir/run.sh', true]
      ],
      name
    )
  }

  const dir = await tmp(t)
  spawnSync('git', ['init', '-q', '--bare', dir])
  await toDisk({ gitDir: dir, objects, refs: { 'refs/heads/main': commit.oid } })
  const fsck = spawnSync('git', ['fsck', '--no-dangling'], { cwd: dir })
  t.is(fsck.status, 0, fsck.stderr.toString())
  const lsTree = spawnSync('git', ['ls-tree', '-r', 'main'], { cwd: dir })
  t.is(lsTree.stdout.toString().split('\n').length - 1, 3, 'git reads the tree')
})

// libgit2's `nasty` repo: names a checkout must never follow. A clone still
// needs the objects, so they are stored; only the file views leave them out.
test('unsafe names in trees are stored but never become paths', async (t) => {
  const remote = await create(t)
  const blob = git.blob('evil')
  const dotgit = git.tree([{ mode: '100644', name: 'config', oid: blob.oid }])
  const tree = git.tree([
    { mode: '40000', name: '.git', oid: dotgit.oid },
    { mode: '40000', name: '.GIT', oid: dotgit.oid },
    { mode: '40000', name: '..', oid: dotgit.oid },
    { mode: '100644', name: '.', oid: blob.oid },
    { mode: '100644', name: 'a/b', oid: blob.oid },
    { mode: '100644', name: '..\\escape', oid: blob.oid },
    { mode: '100644', name: 'ok.txt', oid: blob.oid }
  ])
  const commit = git.commit({ tree: tree.oid })
  const all = [blob, dotgit, tree, commit]

  await remote.push('main', commit.oid, git.toObjects(all))
  await remote.push('tags/v1', commit.oid, new Map())

  t.is((await remote.getBranchRef('main')).oid, commit.oid, 'the ref lands')
  const objects = await remote.getRefObjects(commit.oid)
  t.alike(objects.map((o) => o.id).sort(), all.map((o) => o.oid).sort(), 'every object is served')
  t.ok(b4a.equals(objects.find((o) => o.id === tree.oid).data, tree.data), 'tree bytes untouched')

  for (const name of ['refs/heads/main', 'refs/tags/v1']) {
    const drive = await remote.toDrive(name)
    const listed = []
    for await (const entry of drive.list('/')) listed.push(entry.key)
    const names = []
    for await (const entry of drive.readdir('/')) names.push(entry)

    t.alike(listed, ['/ok.txt'], name + ' list')
    t.alike(names, ['ok.txt'], name + ' readdir')
    t.is(await drive.entry('/.git/config'), null, name + ' entry')
    t.is(await drive.get('/../config'), null, name + ' get')
  }
})

async function create(t) {
  const remote = new Remote(await createStore(t), 'trees')
  t.teardown(() => remote.close(), { order: -1 })
  await remote.ready()
  return remote
}
