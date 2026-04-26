const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const { makeTestObjects, createRemote, OID_BLOB1, OID_TREE_ROOT } = require('./helpers')

test('replicate', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const r1 = await createRemote(t, { name: 'r1', bootstrap })

  const objects = makeTestObjects()

  const oid = 'ee'.repeat(20)
  await r1.push('main', oid, objects)

  {
    const o = await r1.getObject(oid)
    t.is(o.oid, oid)
    t.is(o.size, 164)
  }

  const r2 = await createRemote(t, { link: r1.url, bootstrap })

  t.alike(r1.key, r2.key)

  t.is(r1.core.length, r2.core.length)

  {
    const o = await r2.getObject(oid)
    t.is(o.oid, oid)
    t.is(o.size, 164)
  }
})

// Regression test for an issue a user reported: push, then clone, and the
// clone is missing one commit. The most likely shape is a race between the
// writer flushing and the reader settling on `core.length` — the reader
// might compute a "downloaded" range that excludes the latest blocks.
//
// We exercise this by pushing TWO commits (B parented on A) on the writer,
// then opening a fresh reader and asserting that BOTH commits + their refs
// + their objects survive replication.
test('replicate captures both commits after a follow-up push', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)

  const r1 = await createRemote(t, { name: 'follow-up', bootstrap })

  // Commit A — the standard fixture (README + src/index.js).
  const objectsA = makeTestObjects()
  const OID_COMMIT_A = 'ee'.repeat(20)
  await r1.push('main', OID_COMMIT_A, objectsA)

  // Commit B — parented on A, same tree, just to keep the test focused on
  // commit-graph survival rather than tree contents. New OID so it must be
  // distinguishable from A.
  const OID_COMMIT_B = 'aa11'.repeat(10)
  const commitBText = [
    `tree ${OID_TREE_ROOT}`,
    `parent ${OID_COMMIT_A}`,
    'author Test User <test@test.com> 1700000200 +0000',
    'committer Test User <test@test.com> 1700000200 +0000',
    '',
    'follow-up commit'
  ].join('\n')
  const commitBData = Buffer.from(commitBText)
  const objectsB = new Map()
  // Carry the unchanged tree + blobs forward — push() is idempotent for
  // pre-existing object oids, so this matches what a real client would send.
  objectsB.set(OID_BLOB1, objectsA.get(OID_BLOB1))
  objectsB.set(OID_TREE_ROOT, objectsA.get(OID_TREE_ROOT))
  objectsB.set(OID_COMMIT_B, { type: 'commit', size: commitBData.length, data: commitBData })

  await r1.push('main', OID_COMMIT_B, objectsB)

  // Sanity on the writer side: ref points at B, both commits readable.
  const writerRef = await r1.getBranchRef('main')
  t.is(writerRef.oid, OID_COMMIT_B, 'writer main points at B')
  t.ok(await r1.getObject(OID_COMMIT_A), 'writer has commit A')
  t.ok(await r1.getObject(OID_COMMIT_B), 'writer has commit B')

  // Fresh reader replicates from scratch — this is the path a `git clone`
  // exercises. After the helper finishes (joins swarm + waits for update),
  // the reader's view should be identical to the writer's.
  const r2 = await createRemote(t, { link: r1.url, bootstrap })
  t.is(r1.core.length, r2.core.length, 'reader caught up on length')

  // Refs survive — main points at B, not A.
  const readerRef = await r2.getBranchRef('main')
  t.ok(readerRef, 'reader has main ref')
  t.is(readerRef.oid, OID_COMMIT_B, 'reader main points at B')

  // Objects survive — both commits readable, plus B's parent chain back
  // through A. This is the exact "missing 1 commit" scenario.
  const a = await r2.getObject(OID_COMMIT_A)
  t.ok(a, 'reader has commit A')
  t.is(a.oid, OID_COMMIT_A)

  const b = await r2.getObject(OID_COMMIT_B)
  t.ok(b, 'reader has commit B')
  t.is(b.oid, OID_COMMIT_B)

  // getRefObjects from the head must enumerate both commits and the tree —
  // this is what the git remote helper uses to pack objects on fetch.
  const objs = await r2.getRefObjects(OID_COMMIT_B)
  const ids = objs.map((o) => o.id)
  t.ok(ids.includes(OID_COMMIT_B), 'getRefObjects yields B')
  t.ok(ids.includes(OID_COMMIT_A), 'getRefObjects yields A (B\'s parent)')
  t.ok(ids.includes(OID_TREE_ROOT), 'getRefObjects yields the tree')
  t.ok(ids.includes(OID_BLOB1), 'getRefObjects yields the blob')
})
