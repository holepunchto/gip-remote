const test = require('brittle')
const b4a = require('b4a')
const { createStore } = require('./helpers')
const git = require('./helpers/git')
const { Remote } = require('..')

test('pushRef takes full ref names', async (t) => {
  const remote = await create(t)
  const one = repo('one')
  const two = repo('two')

  await remote.pushRef('refs/heads/main', one.commit.oid, one.objects)
  await remote.pushRef('refs/tags/v1', two.commit.oid, two.objects)

  t.alike(await remote.getAllRefs(), [
    { ref: 'HEAD', symref: 'refs/heads/main', oid: one.commit.oid },
    { ref: 'refs/tags/v1', oid: two.commit.oid },
    { ref: 'refs/heads/main', oid: one.commit.oid }
  ])
})

test('refs outside refs/heads and refs/tags are unsupported', async (t) => {
  const remote = await create(t)
  const { commit, objects } = repo('one')

  for (const ref of ['refs/notes/commits', 'refs/pull/1/head', 'HEAD', 'main', 'refs/heads/']) {
    const pushed = await remote.pushRef(ref, commit.oid, objects).catch((err) => err)
    t.is(pushed.code, 'UNSUPPORTED_REF', 'push ' + ref)
    const deleted = await remote.deleteRef(ref).catch((err) => err)
    t.is(deleted.code, 'UNSUPPORTED_REF', 'delete ' + ref)
  }

  t.alike(await remote.getAllRefs(), [])
  t.is(await remote.getObject(commit.oid), null, 'nothing stored')
})

for (const ref of ['refs/heads/x', 'refs/tags/x']) {
  test(`pushRef and deleteRef check expect: ${ref}`, async (t) => {
    const remote = await create(t)
    const one = repo('one')
    const two = repo('two')
    const tip = async () => (await remote.getAllRefs()).find((r) => r.ref === ref)?.oid ?? null

    // the head branch, so that x isn't
    const main = repo('main')
    await remote.pushRef('refs/heads/main', main.commit.oid, main.objects)

    const stale = (promise) =>
      promise.then(
        () => null,
        (err) => err.code
      )

    t.is(
      await stale(remote.pushRef(ref, one.commit.oid, one.objects, { expect: two.commit.oid })),
      'STALE_REF',
      'a missing ref is not at an oid'
    )
    t.is(await remote.getObject(one.commit.oid), null, 'a stale push stores nothing')

    await remote.pushRef(ref, one.commit.oid, one.objects, { expect: null })
    t.is(await tip(), one.commit.oid, 'created')

    t.is(
      await stale(remote.pushRef(ref, two.commit.oid, two.objects, { expect: null })),
      'STALE_REF',
      'the ref exists'
    )
    t.is(
      await stale(remote.pushRef(ref, two.commit.oid, two.objects, { expect: two.commit.oid })),
      'STALE_REF',
      'the ref is elsewhere'
    )
    t.is(await tip(), one.commit.oid, 'unmoved')

    await remote.pushRef(ref, two.commit.oid, two.objects, { expect: one.commit.oid })
    t.is(await tip(), two.commit.oid, 'moved')

    t.is(await stale(remote.deleteRef(ref, { expect: one.commit.oid })), 'STALE_REF')
    t.is(await stale(remote.deleteRef(ref, { expect: null })), 'STALE_REF')
    t.is(await tip(), two.commit.oid, 'not deleted')

    t.is(await remote.deleteRef(ref, { expect: two.commit.oid }), true)
    t.is(await tip(), null, 'deleted')
    t.is(await remote.deleteRef(ref), false, 'deleting a missing ref without expect')
    t.is(await stale(remote.deleteRef(ref, { expect: two.commit.oid })), 'STALE_REF')
  })
}

test('concurrent pushes with the same expect: one wins', async (t) => {
  const remote = await create(t)
  const base = repo('base')
  await remote.pushRef('refs/heads/main', base.commit.oid, base.objects)

  const sides = ['a', 'b', 'c', 'd'].map(repo)
  const results = await Promise.allSettled(
    sides.map((s) =>
      remote.pushRef('refs/heads/main', s.commit.oid, s.objects, { expect: base.commit.oid })
    )
  )

  const won = results.filter((r) => r.status === 'fulfilled')
  t.is(won.length, 1)
  t.ok(results.every((r) => r.status === 'fulfilled' || r.reason.code === 'STALE_REF'))
  const winner = sides[results.findIndex((r) => r.status === 'fulfilled')]
  t.is((await remote.getBranchRef('main')).oid, winner.commit.oid)
})

test('annotated tags carry their peeled target in getAllRefs', async (t) => {
  const remote = await create(t)
  const { commit, objects } = repo('one')
  const tag = git.tag({ object: commit.oid, name: 'v1' })
  const nested = git.tag({ object: tag.oid, type: 'tag', name: 'v1-signed' })

  await remote.pushRef('refs/tags/light', commit.oid, objects)
  await remote.pushRef('refs/tags/v1', tag.oid, git.toObjects([tag]))
  await remote.pushRef('refs/tags/nested', nested.oid, git.toObjects([nested]))

  const refs = await remote.getAllRefs()
  t.alike(
    refs.find((r) => r.ref === 'refs/tags/light'),
    {
      ref: 'refs/tags/light',
      oid: commit.oid
    }
  )
  t.alike(
    refs.find((r) => r.ref === 'refs/tags/v1'),
    {
      ref: 'refs/tags/v1',
      oid: tag.oid,
      peeled: commit.oid
    }
  )
  t.alike(
    refs.find((r) => r.ref === 'refs/tags/nested'),
    {
      ref: 'refs/tags/nested',
      oid: nested.oid,
      peeled: commit.oid
    }
  )
})

test('tags may point at trees and blobs', async (t) => {
  const remote = await create(t)
  const { blob, tree, commit, objects } = repo('one')
  await remote.pushRef('refs/heads/main', commit.oid, objects)

  const annotated = git.tag({ object: blob.oid, type: 'blob', name: 'a-blob' })
  await remote.pushRef('refs/tags/tree', tree.oid, new Map())
  await remote.pushRef('refs/tags/blob', blob.oid, new Map())
  await remote.pushRef('refs/tags/a-blob', annotated.oid, git.toObjects([annotated]))

  const refs = await remote.getAllRefs()
  t.alike(
    refs.find((r) => r.ref === 'refs/tags/tree'),
    { ref: 'refs/tags/tree', oid: tree.oid }
  )
  t.alike(
    refs.find((r) => r.ref === 'refs/tags/blob'),
    { ref: 'refs/tags/blob', oid: blob.oid }
  )
  t.alike(
    refs.find((r) => r.ref === 'refs/tags/a-blob'),
    {
      ref: 'refs/tags/a-blob',
      oid: annotated.oid,
      peeled: blob.oid
    }
  )

  const ids = async (oid) => (await remote.getRefObjects(oid)).map((o) => o.id).sort()
  t.alike(await ids(tree.oid), [tree.oid, blob.oid].sort())
  t.alike(await ids(blob.oid), [blob.oid])
  t.alike(await ids(annotated.oid), [annotated.oid, blob.oid].sort())

  t.is(await remote.toDrive('refs/tags/tree'), null, 'no drive view')
  t.is(await remote.toDrive('refs/tags/blob'), null)

  const err = await remote.pushRef('refs/heads/tree', tree.oid, new Map()).catch((err) => err)
  t.ok(err.message.includes('Expected commit'), 'branches stay commits')
})

test('the default head is main, else master, else the first branch pushed', async (t) => {
  const { commit, objects } = repo('one')

  const first = await create(t)
  await first.pushRef('refs/heads/dev', commit.oid, objects)
  t.is(await first.getHead(), 'dev', 'the first branch pushed')
  await first.pushRef('refs/heads/zeta', commit.oid, objects)
  t.is(await first.getHead(), 'dev')
  await first.pushRef('refs/heads/master', commit.oid, objects)
  t.is(await first.getHead(), 'master', 'master takes over')
  await first.pushRef('refs/heads/main', commit.oid, objects)
  t.is(await first.getHead(), 'main', 'main takes over')
  await first.pushRef('refs/heads/master', commit.oid, objects)
  t.is(await first.getHead(), 'main', 'and keeps it')

  const chosen = await create(t)
  await chosen.pushRef('refs/heads/dev', commit.oid, objects)
  await chosen.setHead('dev')
  await chosen.pushRef('refs/heads/main', commit.oid, objects)
  t.is(await chosen.getHead(), 'dev', 'a head that was set is never moved')
})

test('a head defaulted by an earlier session stays', async (t) => {
  const store = await createStore(t)
  const { commit, objects } = repo('one')

  const a = new Remote(store.session(), 'head')
  await a.pushRef('refs/heads/dev', commit.oid, objects)
  await a.close()

  const b = new Remote(store.session(), 'head')
  t.teardown(() => b.close(), { order: -1 })
  await b.pushRef('refs/heads/main', commit.oid, objects)
  t.is(await b.getHead(), 'dev')
})

test('deleteRef refuses to delete the head branch', async (t) => {
  const remote = await create(t)
  const { commit, objects } = repo('one')
  await remote.pushRef('refs/heads/main', commit.oid, objects)
  await remote.pushRef('refs/heads/dev', commit.oid, objects)

  const err = await remote.deleteRef('refs/heads/main').catch((err) => err)
  t.is(err.code, 'DELETE_HEAD')
  t.is((await remote.getBranchRef('main')).oid, commit.oid)

  await remote.setHead('dev')
  t.is(await remote.deleteRef('refs/heads/main'), true)

  t.is(await remote.deleteBranch('dev'), true, 'deleteBranch still deletes the head branch')
  t.is(await remote.deleteRef('refs/heads/dev'), false, 'already gone')
})

test('push takes an iterable or an async iterable of objects', async (t) => {
  const remote = await create(t)
  const base = repo('base')
  const blob = git.blob('second')
  const tree = git.tree([
    { mode: '100644', name: 'base.txt', oid: base.blob.oid },
    { mode: '100644', name: 'second.txt', oid: blob.oid }
  ])
  const commit = git.commit({ tree: tree.oid, parents: [base.commit.oid], message: 'second' })

  const list = (objects) => objects.map(({ oid, type, size, data }) => ({ oid, type, size, data }))
  await remote.pushRef(
    'refs/heads/main',
    base.commit.oid,
    list([base.blob, base.tree, base.commit])
  )

  async function* thin() {
    for (const obj of list([commit, tree, blob])) yield obj
  }
  await remote.pushRef('refs/heads/main', commit.oid, thin(), { expect: base.commit.oid })

  t.is((await remote.getBranchRef('main')).oid, commit.oid)
  const drive = await remote.toDrive('main')
  t.is((await drive.entry('/base.txt')).value.blob.byteLength, 4)
  t.is((await drive.entry('/second.txt')).value.blob.byteLength, 6)
  t.ok(b4a.equals(await drive.get('/second.txt'), blob.data))
  t.is((await remote.getRefObjects(commit.oid)).length, 6)

  async function* shallow() {
    yield* list([git.commit({ tree: tree.oid, parents: ['ab'.repeat(20)] })])
  }
  const err = await remote.pushRef('refs/heads/x', 'cd'.repeat(20), shallow()).catch((err) => err)
  t.is(err.code, 'MISSING_OBJECTS')
})

async function create(t) {
  const remote = new Remote(await createStore(t), 'refs')
  t.teardown(() => remote.close(), { order: -1 })
  await remote.ready()
  return remote
}

// A one-file repo, the file named after `label`
function repo(label) {
  const blob = git.blob(label)
  const tree = git.tree([{ mode: '100644', name: label + '.txt', oid: blob.oid }])
  const commit = git.commit({ tree: tree.oid, message: label })
  return { blob, tree, commit, objects: git.toObjects([blob, tree, commit]) }
}
