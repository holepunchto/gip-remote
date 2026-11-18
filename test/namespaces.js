const test = require('brittle')
const b4a = require('b4a')
const { createStore } = require('./helpers')
const git = require('./helpers/git')
const { bug } = require('./helpers/fuzz')
const { Remote } = require('..')

test('a branch and a tag of the same name are independent refs', async (t) => {
  const remote = await create(t)
  const one = repo('one')
  const two = repo('two')

  await remote.push('x', one.commit.oid, one.objects)
  await remote.push('tags/x', two.commit.oid, two.objects)
  t.alike(await refs(remote), {
    HEAD: one.commit.oid,
    'refs/heads/x': one.commit.oid,
    'refs/tags/x': two.commit.oid
  })

  t.ok(await remote.deleteTag('x'))
  t.alike(await refs(remote), { HEAD: one.commit.oid, 'refs/heads/x': one.commit.oid })
  t.alike(await paths(await remote.toDrive('x')), ['/one.txt'], 'branch files survive')

  await remote.push('tags/x', two.commit.oid, two.objects)
  t.ok(await remote.deleteBranch('x'))
  t.alike(await refs(remote), { 'refs/tags/x': two.commit.oid })
  t.alike(await paths(await remote.toDrive('x')), ['/two.txt'], 'tag files survive')
})

bug('BUG: toDrive cannot reach a tag that shares its name with a branch', async (t) => {
  const remote = await create(t)
  const one = repo('one')
  const two = repo('two')

  await remote.push('x', one.commit.oid, one.objects)
  await remote.push('tags/x', two.commit.oid, two.objects)

  t.alike(await paths(await remote.toDrive('x')), ['/one.txt'])
  t.alike(await paths(await remote.toDrive('tags/x')), ['/two.txt'])
})

bug('BUG: a branch named tags/x is stored as the tag x', async (t) => {
  const remote = await create(t)
  const one = repo('one')
  const two = repo('two')

  // refs/tags/x, then refs/heads/tags/x the way the transport names them
  await remote.push('tags/x', one.commit.oid, one.objects)
  await remote.push('tags/x', two.commit.oid, two.objects)

  t.alike(await refs(remote), {
    HEAD: two.commit.oid,
    'refs/heads/tags/x': two.commit.oid,
    'refs/tags/x': one.commit.oid
  })
})

test('a full ref name pushed as a branch stays a branch of that name', async (t) => {
  const remote = await create(t)
  const { commit, objects } = repo('notes')

  await remote.push('refs/notes/commits', commit.oid, objects)
  t.alike(await refs(remote), {
    HEAD: commit.oid,
    'refs/heads/refs/notes/commits': commit.oid
  })
  t.alike(await remote.getBranchRef('refs/notes/commits'), {
    ref: 'refs/heads/refs/notes/commits',
    oid: commit.oid
  })
  t.alike(await paths(await remote.toDrive('refs/notes/commits')), ['/notes.txt'])

  t.ok(await remote.deleteBranch('refs/notes/commits'))
  t.alike(await refs(remote), {})
})

test('branches whose names prefix each other keep separate files', async (t) => {
  const remote = await create(t)
  const names = ['feature', 'feature/x', 'feature2', 'featur']

  for (const name of names) {
    const { commit, objects } = repo(name.replace('/', '-'))
    await remote.push(name, commit.oid, objects)
  }

  t.ok(await remote.deleteBranch('feature'))
  t.is(await remote.toDrive('feature'), null)
  t.alike(await paths(await remote.toDrive('feature/x')), ['/feature-x.txt'])
  t.alike(await paths(await remote.toDrive('feature2')), ['/feature2.txt'])
  t.alike(await paths(await remote.toDrive('featur')), ['/featur.txt'])

  const again = repo('again')
  await remote.push('feature', again.commit.oid, again.objects)
  t.alike(await paths(await remote.toDrive('feature')), ['/again.txt'], 'no stale files')
})

for (const name of ['ünï/日本語/😀', 'with space', 'n'.repeat(255), 'n'.repeat(4096)]) {
  const label = name.length > 20 ? `${name.length} chars` : name

  test(`branch and tag names round-trip: ${label}`, async (t) => {
    const remote = await create(t)
    const { commit, blob, objects } = repo('😀 ünï')

    await remote.push('tags/' + name, commit.oid, objects)
    const tagged = await remote.toDrive(name)
    await remote.push(name, commit.oid, objects)
    const branched = await remote.toDrive(name)

    t.alike(await refs(remote), {
      HEAD: commit.oid,
      ['refs/heads/' + name]: commit.oid,
      ['refs/tags/' + name]: commit.oid
    })
    t.is(await remote.getHead(), name)

    for (const drive of [tagged, branched]) {
      t.alike(await paths(drive), ['/😀 ünï.txt'])
      t.ok(b4a.equals(await drive.get('/😀 ünï.txt'), blob.data))
    }

    t.ok(await remote.deleteBranch(name))
    t.ok(await remote.deleteTag(name))
    t.alike(await refs(remote), {})
  })
}

async function create(t) {
  const remote = new Remote(await createStore(t), 'namespaces')
  t.teardown(() => remote.close(), { order: -1 })
  await remote.ready()
  return remote
}

// A one-file repo, the file named after `label`
function repo(label) {
  const blob = git.blob(label)
  const tree = git.tree([{ mode: '100644', name: label + '.txt', oid: blob.oid }])
  const commit = git.commit({ tree: tree.oid, message: label })
  return { blob, commit, objects: git.toObjects([blob, tree, commit]) }
}

async function refs(remote) {
  const out = {}
  for (const { ref, oid } of await remote.getAllRefs()) out[ref] = oid
  return out
}

async function paths(drive) {
  if (drive === null) return null
  const out = []
  for await (const entry of drive.list('/')) out.push(entry.key)
  return out.sort()
}
