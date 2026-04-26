const test = require('brittle')
const {
  createStore,
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

const { parseCommit, walkTree } = require('../')
const { parseTag } = require('../lib/git')

// --- parseCommit ---

test('parseCommit extracts metadata', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'parent def456',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Bob <bob@example.com> 1700000001 +0000',
      '',
      'Fix the thing',
      '',
      'More details here.'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.is(commit.tree, 'abc123')
  t.alike(commit.parents, ['def456'])
  t.is(commit.author, 'Alice')
  t.is(commit.timestamp, 1700000000)
  t.is(commit.message, 'Fix the thing\n\nMore details here.')
})

test('parseCommit handles no parent', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Alice <alice@example.com> 1700000000 +0000',
      '',
      'initial'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.is(commit.tree, 'abc123')
  t.alike(commit.parents, [])
  t.is(commit.message, 'initial')
})

test('parseCommit handles multiple parents (merge commit)', (t) => {
  const data = Buffer.from(
    [
      'tree abc123',
      'parent def456',
      'parent 789abc',
      'author Alice <alice@example.com> 1700000000 +0000',
      'committer Alice <alice@example.com> 1700000000 +0000',
      '',
      'merge branch'
    ].join('\n')
  )

  const commit = parseCommit(data)

  t.alike(commit.parents, ['def456', '789abc'])
  t.is(commit.message, 'merge branch')
})

// --- walkTree ---

test('walkTree enumerates all files', (t) => {
  const objects = makeTestObjects()
  const files = walkTree(objects, OID_TREE_ROOT, '')

  t.is(files.length, 2)

  const readme = files.find((f) => f.path === '/README.md')
  t.ok(readme, 'found README.md')
  t.is(readme.oid, OID_BLOB1)
  t.is(readme.size, 11)

  const index = files.find((f) => f.path === '/src/index.js')
  t.ok(index, 'found src/index.js')
  t.is(index.oid, OID_BLOB2)
})

test('walkTree returns empty for missing tree', (t) => {
  const objects = new Map()
  const files = walkTree(objects, 'deadbeef'.repeat(5), '')
  t.is(files.length, 0)
})

// --- Remote ---

test('remote has key after ready', async (t) => {
  const remote = await createRemote(t, { name: 'test-repo' })
  t.ok(remote.key, 'has key')
  t.ok(remote.discoveryKey, 'has discoveryKey')
  t.is(remote.name, 'test-repo')
})

test('two remotes on same store get unique keys', async (t) => {
  const store = await createStore(t)
  const remote1 = new (require('../').Remote)(store, 'repo-one')
  const remote2 = new (require('../').Remote)(store, 'repo-two')
  t.teardown(() => remote1.close())
  t.teardown(() => remote2.close())
  await remote1.ready()
  await remote2.ready()

  t.ok(remote1.key, 'remote1 has key')
  t.ok(remote2.key, 'remote2 has key')
  t.unlike(remote1.key, remote2.key, 'keys are different')
  t.is(remote1.name, 'repo-one')
  t.is(remote2.name, 'repo-two')
})

test('push stores objects and branch', async (t) => {
  const remote = await createRemote(t, { name: 'push-test' })
  const objects = makeTestObjects()

  await remote.push('main', OID_COMMIT, objects)

  // Check branch
  const refs = await remote.getAllRefs()
  const main = refs.find((r) => r.ref === 'refs/heads/main')
  t.ok(main, 'main branch exists')
  t.is(main.oid, OID_COMMIT)

  // Check HEAD synthesized
  const head = refs.find((r) => r.ref === 'HEAD')
  t.ok(head, 'HEAD exists')
  t.is(head.oid, OID_COMMIT)

  // Check object retrieval
  const blob = await remote.getObject(OID_BLOB1)
  t.ok(blob, 'blob stored')
  t.is(blob.type, 'blob')
  t.is(blob.data.toString(), 'hello world')
})

test('getBranchRef returns null for missing branch', async (t) => {
  const remote = await createRemote(t, { name: 'missing-branch' })
  const ref = await remote.getBranchRef('nonexistent')
  t.is(ref, null)
})

test('getBranchRef returns ref after push', async (t) => {
  const remote = await createRemote(t, { name: 'ref-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const ref = await remote.getBranchRef('main')
  t.ok(ref)
  t.is(ref.ref, 'refs/heads/main')
  t.is(ref.oid, OID_COMMIT)
})

test('getRefObjects returns all objects for a commit', async (t) => {
  const remote = await createRemote(t, { name: 'ref-objects' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const results = await remote.getRefObjects(OID_COMMIT)
  t.is(results.length, objects.size)

  const ids = results.map((r) => r.id)
  for (const oid of objects.keys()) {
    t.ok(ids.includes(oid), `has ${oid.slice(0, 8)}...`)
  }
})

test('push is idempotent for objects', async (t) => {
  const remote = await createRemote(t, { name: 'idempotent' })
  const objects = makeTestObjects()

  await remote.push('main', OID_COMMIT, objects)
  await remote.push('main', OID_COMMIT, objects)

  const blob = await remote.getObject(OID_BLOB1)
  t.ok(blob, 'blob still exists')
  t.is(blob.data.toString(), 'hello world')
})

test('push removes file index entries for paths deleted in the new tree', async (t) => {
  // Regression test: prior behaviour left @gip/files entries for paths that
  // were deleted in a later commit. Drive views and file iterators would
  // surface ghost files until the branch was deleted entirely.
  const remote = await createRemote(t, { name: 'delete-file' })

  // First push: README.md + src/index.js (the standard fixture)
  const initial = makeTestObjects()
  await remote.push('main', OID_COMMIT, initial)

  // Sanity — both files indexed.
  let drive = await remote.toDrive('main')
  let paths = []
  for await (const { key } of drive.list('/')) paths.push(key)
  t.ok(paths.includes('/README.md'), 'README.md in initial index')
  t.ok(paths.includes('/src/index.js'), 'src/index.js in initial index')
  t.is(paths.length, 2, 'two files initially')

  // Second push: a new tree containing only README.md (src/ removed).
  const NEW_TREE = '11'.repeat(20)
  const NEW_COMMIT = '22'.repeat(20)

  // Tree with just README.md → blob1
  const treeData = Buffer.concat([Buffer.from('100644 README.md\0'), Buffer.from(OID_BLOB1, 'hex')])
  const commitText = [
    `tree ${NEW_TREE}`,
    `parent ${OID_COMMIT}`,
    'author Test User <test@test.com> 1700000100 +0000',
    'committer Test User <test@test.com> 1700000100 +0000',
    '',
    'remove src/'
  ].join('\n')
  const commitData = Buffer.from(commitText)

  const next = new Map()
  next.set(OID_BLOB1, initial.get(OID_BLOB1)) // unchanged blob
  next.set(NEW_TREE, { type: 'tree', size: treeData.length, data: treeData })
  next.set(NEW_COMMIT, { type: 'commit', size: commitData.length, data: commitData })

  await remote.push('main', NEW_COMMIT, next)

  // After the rewrite, the drive should reflect only the surviving file —
  // src/index.js must be gone from the index.
  drive = await remote.toDrive('main')
  paths = []
  for await (const { key } of drive.list('/')) paths.push(key)

  t.ok(paths.includes('/README.md'), 'README.md still indexed')
  t.absent(paths.includes('/src/index.js'), 'deleted file is gone from index')
  t.is(paths.length, 1, 'exactly one file after deletion')
})

// --- deleteBranch ---

test('deleteBranch removes branch and files', async (t) => {
  const remote = await createRemote(t, { name: 'delete-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const before = await remote.getBranchRef('main')
  t.ok(before, 'branch exists before delete')

  const deleted = await remote.deleteBranch('main')
  t.is(deleted, true)

  const after = await remote.getBranchRef('main')
  t.is(after, null, 'branch gone after delete')

  const refs = await remote.getAllRefs()
  const main = refs.find((r) => r.ref === 'refs/heads/main')
  t.absent(main, 'main not in refs')

  const drive = await remote.toDrive('main')
  t.is(drive, null, 'drive returns null after delete')
})

test('deleteBranch returns false for missing branch', async (t) => {
  const remote = await createRemote(t, { name: 'delete-missing' })
  const deleted = await remote.deleteBranch('nonexistent')
  t.is(deleted, false)
})

test('deleteBranch only removes targeted branch', async (t) => {
  const remote = await createRemote(t, { name: 'delete-multi' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)
  await remote.push('feature', OID_COMMIT, objects)

  await remote.deleteBranch('feature')

  const main = await remote.getBranchRef('main')
  t.ok(main, 'main still exists')

  const feature = await remote.getBranchRef('feature')
  t.is(feature, null, 'feature is gone')

  // main files still accessible
  const drive = await remote.toDrive('main')
  t.ok(drive, 'main drive still works')
})

// --- parseTag ---

test('parseTag extracts metadata', (t) => {
  const data = Buffer.from(
    [
      `object ${OID_COMMIT}`,
      'type commit',
      'tag v1.0.0',
      'tagger Test User <test@test.com> 1700000000 +0000',
      '',
      'Release v1.0.0'
    ].join('\n')
  )

  const tag = parseTag(data)

  t.is(tag.object, OID_COMMIT)
  t.is(tag.type, 'commit')
  t.is(tag.tag, 'v1.0.0')
  t.is(tag.tagger, 'Test User')
  t.is(tag.timestamp, 1700000000)
  t.is(tag.message, 'Release v1.0.0')
})

test('parseTag handles tag pointing to another tag', (t) => {
  const innerTagOid = 'ab'.repeat(20)
  const data = Buffer.from(
    [
      `object ${innerTagOid}`,
      'type tag',
      'tag v2.0.0',
      'tagger Test User <test@test.com> 1700000000 +0000',
      '',
      'Nested tag'
    ].join('\n')
  )

  const tag = parseTag(data)
  t.is(tag.object, innerTagOid)
  t.is(tag.type, 'tag')
})

// --- Tag push ---

test('push annotated tag stores objects and lists as refs/tags/', async (t) => {
  const remote = await createRemote(t, { name: 'tag-push' })
  const objects = makeTagObjects()

  await remote.push('tags/v1.0.0', OID_TAG, objects)

  const refs = await remote.getAllRefs()
  const tag = refs.find((r) => r.ref === 'refs/tags/v1.0.0')
  t.ok(tag, 'tag ref exists')
  t.is(tag.oid, OID_TAG)

  // Tag should not set HEAD
  const head = refs.find((r) => r.ref === 'HEAD')
  t.absent(head, 'HEAD not set by tag push')
})

test('push tag dereferences to commit for files', async (t) => {
  const remote = await createRemote(t, { name: 'tag-files' })
  const objects = makeTagObjects()

  await remote.push('tags/v1.0.0', OID_TAG, objects)

  // Files should still be indexed (from the dereferenced commit)
  const drive = await remote.toDrive('v1.0.0')
  t.ok(drive, 'drive created for tag')

  const entries = []
  for await (const entry of drive.list('/')) {
    entries.push(entry)
  }

  const keys = entries.map((e) => e.key)
  t.ok(keys.includes('/README.md'), 'has README.md')
  t.ok(keys.includes('/src/index.js'), 'has src/index.js')
})

test('push tag does not interfere with branch HEAD', async (t) => {
  const remote = await createRemote(t, { name: 'tag-no-head' })
  const objects = makeTagObjects()

  // Push tag first
  await remote.push('tags/v1.0.0', OID_TAG, objects)

  // Then push branch
  await remote.push('main', OID_COMMIT, objects)

  const refs = await remote.getAllRefs()
  const head = refs.find((r) => r.ref === 'HEAD')
  t.ok(head, 'HEAD exists after branch push')
  t.is(head.symref, 'refs/heads/main', 'HEAD points to main, not the tag')
})

test('push both branches and tags', async (t) => {
  const remote = await createRemote(t, { name: 'mixed-push' })
  const objects = makeTagObjects()

  await remote.push('main', OID_COMMIT, objects)
  await remote.push('tags/v1.0.0', OID_TAG, objects)

  const refs = await remote.getAllRefs()

  const main = refs.find((r) => r.ref === 'refs/heads/main')
  t.ok(main, 'branch exists')
  t.is(main.oid, OID_COMMIT)

  const tag = refs.find((r) => r.ref === 'refs/tags/v1.0.0')
  t.ok(tag, 'tag exists')
  t.is(tag.oid, OID_TAG)
})

test('deleteTag removes tag and files', async (t) => {
  const remote = await createRemote(t, { name: 'delete-tag' })
  const objects = makeTagObjects()

  await remote.push('tags/v1.0.0', OID_TAG, objects)

  const before = await remote.getAllRefs()
  t.ok(
    before.find((r) => r.ref === 'refs/tags/v1.0.0'),
    'tag exists before delete'
  )

  const deleted = await remote.deleteTag('v1.0.0')
  t.is(deleted, true)

  const after = await remote.getAllRefs()
  t.absent(
    after.find((r) => r.ref === 'refs/tags/v1.0.0'),
    'tag gone after delete'
  )

  const drive = await remote.toDrive('v1.0.0')
  t.is(drive, null, 'drive returns null after delete')
})

test('deleteTag returns false for missing tag', async (t) => {
  const remote = await createRemote(t, { name: 'delete-missing-tag' })
  const deleted = await remote.deleteTag('nonexistent')
  t.is(deleted, false)
})

test('deleteTag does not affect branches', async (t) => {
  const remote = await createRemote(t, { name: 'delete-tag-keep-branch' })
  const objects = makeTagObjects()

  await remote.push('main', OID_COMMIT, objects)
  await remote.push('tags/v1.0.0', OID_TAG, objects)

  await remote.deleteTag('v1.0.0')

  const main = await remote.getBranchRef('main')
  t.ok(main, 'branch still exists')

  const drive = await remote.toDrive('main')
  t.ok(drive, 'branch drive still works')
})

test('getRefObjects works for tag commits', async (t) => {
  const remote = await createRemote(t, { name: 'tag-ref-objects' })
  const objects = makeTagObjects()

  await remote.push('tags/v1.0.0', OID_TAG, objects)

  const results = await remote.getRefObjects(OID_TAG)
  t.is(results.length, objects.size)

  const ids = results.map((r) => r.id)
  t.ok(ids.includes(OID_TAG), 'includes tag object')
  t.ok(ids.includes(OID_COMMIT), 'includes commit object')
  t.ok(ids.includes(OID_BLOB1), 'includes blob object')
})

// --- Drive ---

test('toDrive returns null for missing branch', async (t) => {
  const remote = await createRemote(t, { name: 'no-drive' })
  const drive = await remote.toDrive('main')
  t.is(drive, null)
})

test('toDrive lists files and reads content', async (t) => {
  const remote = await createRemote(t, { name: 'drive-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')
  t.ok(drive, 'drive created')

  const paths = []
  for await (const { key } of drive.list('/')) {
    paths.push(key)
  }

  t.ok(paths.includes('/README.md'), 'has README.md')
  t.ok(paths.includes('/src/index.js'), 'has src/index.js')
  t.is(paths.length, 2)

  const content = await drive.get('/README.md')
  t.is(content.toString(), 'hello world')
})

test('drive entry returns correct metadata', async (t) => {
  const remote = await createRemote(t, { name: 'entry-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const entry = await drive.entry('/README.md')
  t.ok(entry, 'entry found')
  t.is(entry.key, '/README.md')
  t.is(entry.value.blob.byteLength, 11)
  t.is(entry.value.executable, false)

  const missing = await drive.entry('/nope.txt')
  t.is(missing, null, 'missing entry returns null')
})

test('drive readdir returns immediate children', async (t) => {
  const remote = await createRemote(t, { name: 'readdir-test' })
  const objects = makeTestObjects()
  await remote.push('main', OID_COMMIT, objects)

  const drive = await remote.toDrive('main')

  const rootEntries = []
  for await (const name of drive.readdir('/')) {
    rootEntries.push(name)
  }

  t.ok(rootEntries.includes('README.md'), 'has README.md')
  t.ok(rootEntries.includes('src'), 'has src dir')
  t.is(rootEntries.length, 2)
})
