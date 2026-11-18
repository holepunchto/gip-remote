const test = require('brittle')
const { createStore } = require('./helpers')
const git = require('./helpers/git')
const { Remote } = require('..')

// More files than one transaction of index rows holds
const MANY = 5000

test('a file index too large for one transaction is written whole', async (t) => {
  const remote = await create(t)
  const first = repo(MANY, 0)
  await remote.push('main', first.commit.oid, first.objects)

  let drive = await remote.toDrive('main')
  t.is(await rows(remote, 'main'), MANY)
  t.is((await paths(drive)).length, MANY)
  t.is((await drive.entry('/f42.txt')).value.blob.byteLength, 10)

  // every file changes, and half of them go
  const second = repo(MANY / 2, 1, [first.commit.oid])
  await remote.push('main', second.commit.oid, second.objects)

  drive = await remote.toDrive('main')
  t.is(await rows(remote, 'main'), MANY / 2, 'no rows of deleted files')
  t.alike(await paths(drive), second.paths)
  t.is((await drive.get('/f42.txt')).toString(), 'file 42 v1')

  t.ok(await remote.deleteBranch('main'))
  t.is(await rows(remote, 'main'), 0, 'no rows of a deleted branch')
  t.is(await remote.toDrive('main'), null)
})

test('a branch whose index is behind its ref is served from its tree', async (t) => {
  const remote = await create(t)
  const first = repo(3, 0)
  const second = repo(5, 1, [first.commit.oid])
  await remote.push('main', first.commit.oid, first.objects)
  await remote.push('other', second.commit.oid, second.objects)

  // What a push that died between moving the ref and finishing the index
  // leaves: main at the second commit, its rows still those of the first.
  const branch = await remote._db.get('@gip/branches', { name: 'other' })
  await remote._db.insert('@gip/branches', { ...branch, name: 'main' })
  await remote._db.insert('@gip/file-commits', { branch: 'main', path: '', commitOid: '' })
  await remote._db.flush()

  const drive = await remote.toDrive('main')
  t.alike(await paths(drive), second.paths, 'the files of the tree the ref is at')
  t.is((await drive.get('/f0.txt')).toString(), 'file 0 v1')
  t.is((await drive.entry('/f4.txt')).value.blob.byteLength, 9)

  // the next push of the branch puts the index right
  const third = repo(4, 2, [second.commit.oid])
  await remote.push('main', third.commit.oid, third.objects)
  t.is(await rows(remote, 'main'), 4)
  t.alike(await paths(await remote.toDrive('main')), third.paths)
  t.is((await (await remote.toDrive('main')).get('/f0.txt')).toString(), 'file 0 v2')
})

async function create(t) {
  const remote = new Remote(await createStore(t), 'index')
  t.teardown(() => remote.close(), { order: -1 })
  await remote.ready()
  return remote
}

// A commit over `count` files, their content marked with `version`
function repo(count, version, parents = []) {
  const blobs = []
  const entries = []
  for (let i = 0; i < count; i++) {
    const blob = git.blob(`file ${i} v${version}`)
    blobs.push(blob)
    entries.push({ mode: '100644', name: `f${i}.txt`, oid: blob.oid })
  }
  const tree = git.tree(entries)
  const commit = git.commit({ tree: tree.oid, parents, time: 1700000000 + version })
  return {
    commit,
    objects: git.toObjects([...blobs, tree, commit]),
    paths: entries.map((e) => '/' + e.name).sort()
  }
}

async function rows(remote, branch) {
  let n = 0
  for await (const row of remote._db.find('@gip/files', { gte: { branch }, lte: { branch } })) {
    if (row) n++
  }
  return n
}

async function paths(drive) {
  const out = []
  for await (const entry of drive.list('/')) out.push(entry.key)
  return out.sort()
}
