const test = require('brittle')
const {
  createRemote,
  makeTestObjects,
  makeTagObjects,
  OID_BLOB1,
  OID_BLOB2,
  OID_COMMIT,
  OID_TAG,
  OID_TREE_ROOT,
  OID_TREE_SRC
} = require('./helpers')

test('tag push skips the file index and stores no object list', async (t) => {
  const remote = await createRemote(t, { name: 'tag-lean' })

  await remote.push('main', OID_COMMIT, makeTestObjects())
  await remote.push('tags/v1.0.0', OID_TAG, makeTagObjects())

  const record = await remote._db.get('@gip/tags', { name: 'v1.0.0' })
  t.is(record.commitOid, OID_COMMIT)
  t.is(record.objects.length, 0, 'no denormalized object list')

  const rows = []
  const files = remote._db.find('@gip/files', {
    gte: { branch: 'tags/v1.0.0' },
    lte: { branch: 'tags/v1.0.0' }
  })
  for await (const row of files) rows.push(row)
  t.is(rows.length, 0, 'no file index rows for the tag')
})

test('tag drive serves the tree lazily', async (t) => {
  const remote = await createRemote(t, { name: 'tag-drive' })

  await remote.push('main', OID_COMMIT, makeTestObjects())
  await remote.push('tags/v1.0.0', OID_TAG, makeTagObjects())

  const drive = await remote.toDrive('v1.0.0')
  t.ok(drive)

  const names = []
  for await (const name of drive.readdir('/')) names.push(name)
  t.alike(names.sort(), ['README.md', 'src'])

  t.is((await drive.get('/README.md')).toString(), 'hello world')
  t.is((await drive.get('/src/index.js')).toString(), 'console.log("hi")')
  t.is(await drive.get('/missing'), null)

  const entry = await drive.entry('/README.md')
  t.is(entry.value.blob.byteLength, 11)
  t.is(await drive.entry('/src'), null, 'directories are not entries')

  const listed = []
  for await (const e of drive.list('/')) listed.push(e.key)
  t.alike(listed.sort(), ['/README.md', '/src/index.js'])
})

test('getRefObjects walks a tag chain to the full reachable set', async (t) => {
  const remote = await createRemote(t, { name: 'tag-walk' })

  await remote.push('main', OID_COMMIT, makeTestObjects())
  await remote.push('tags/v1.0.0', OID_TAG, makeTagObjects())

  const objs = await remote.getRefObjects(OID_TAG)
  const ids = objs.map((o) => o.id).sort()
  t.alike(ids, [OID_BLOB1, OID_BLOB2, OID_COMMIT, OID_TAG, OID_TREE_ROOT, OID_TREE_SRC].sort())
})

test('a shared seen set walks common history once across refs', async (t) => {
  const remote = await createRemote(t, { name: 'shared-seen' })

  await remote.push('main', OID_COMMIT, makeTestObjects())
  await remote.push('tags/v1.0.0', OID_TAG, makeTagObjects())

  const seen = new Set()
  const first = await remote.getRefObjects(OID_COMMIT, null, { seen })
  t.is(first.length, 5)

  // The tag reaches the same commit — only the tag object itself is new.
  const second = await remote.getRefObjects(OID_TAG, null, { seen })
  t.alike(
    second.map((o) => o.id),
    [OID_TAG]
  )
})

test('getRefObjects serves legacy records with stored object lists', async (t) => {
  const remote = await createRemote(t, { name: 'legacy' })

  await remote.push('main', OID_COMMIT, makeTestObjects())

  // Simulate a record written by an older version: denormalized list, but
  // deliberately partial — proving the list (not a walk) is what's served.
  await remote._db.insert('@gip/branches', {
    name: 'old',
    commitOid: OID_COMMIT,
    treeOid: OID_TREE_ROOT,
    author: 'x',
    message: 'y',
    timestamp: 1,
    objects: [OID_COMMIT, OID_TREE_ROOT]
  })
  await remote._db.flush()

  // Ambiguity: both 'main' (empty list) and 'old' (stored list) point at the
  // same commit — the branches scan finds one of them; both must resolve to
  // a complete set or the stored list. Delete main to make it deterministic.
  await remote.deleteBranch('main')

  const objs = await remote.getRefObjects(OID_COMMIT)
  t.is(objs.length, 2, 'stored list served as-is')
})
