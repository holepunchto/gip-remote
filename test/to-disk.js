const test = require('brittle')
const tmp = require('test-tmp')
const { spawnSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { join } = require('path')
const git = require('rebuild-git')

const { toDisk } = require('../lib/git')

// --- Helpers ---

async function createGitDir(t) {
  const dir = await tmp(t)
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

async function computeOid(type, data) {
  return git.writeObject({ type, object: data, dryrun: true })
}

function gitExec(args, opts) {
  const result = spawnSync('git', args, { ...opts, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'git failed')
  return result.stdout.toString()
}

// --- Validation tests ---

test('toDisk throws without gitDir', async (t) => {
  try {
    await toDisk({ objects: [{ type: 'blob', id: 'abc', data: Buffer.alloc(0), size: 0 }] })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'gitDir is required')
  }
})

test('toDisk throws without objects', async (t) => {
  try {
    await toDisk({ gitDir: '/fake/.git' })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'No objects supplied.')
  }
})

test('toDisk throws for empty objects array', async (t) => {
  try {
    await toDisk({ gitDir: '/fake/.git', objects: [] })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'No objects supplied.')
  }
})

test('toDisk throws for non-sha1 objectFormat', async (t) => {
  try {
    await toDisk({
      gitDir: '/fake/.git',
      objectFormat: 'sha256',
      objects: [{ type: 'blob', id: 'abc', data: Buffer.alloc(0), size: 0 }]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'Only sha1 is supported')
  }
})

test('toDisk throws for invalid object entry', async (t) => {
  const dir = await createGitDir(t)

  try {
    await toDisk({
      gitDir: join(dir, '.git'),
      objects: [{ type: null, id: null, data: null }]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Invalid object entry'))
  }
})

test('toDisk throws on size mismatch', async (t) => {
  const dir = await createGitDir(t)

  try {
    await toDisk({
      gitDir: join(dir, '.git'),
      objects: [{ type: 'blob', id: 'abc123', data: Buffer.from('hello'), size: 999 }]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Size mismatch'))
  }
})

test('toDisk skips size check when verifySizes is false', async (t) => {
  const dir = await createGitDir(t)

  try {
    await toDisk({
      gitDir: join(dir, '.git'),
      objects: [{ type: 'blob', id: 'wrong-id', data: Buffer.from('hello'), size: 999 }],
      verifySizes: false
    })
    t.fail('should have thrown with OID mismatch')
  } catch (err) {
    t.ok(err.message.includes('OID mismatch'), 'got past size check to OID mismatch')
  }
})

test('toDisk throws on OID mismatch', async (t) => {
  const dir = await createGitDir(t)

  try {
    await toDisk({
      gitDir: join(dir, '.git'),
      objects: [{ type: 'blob', id: 'deadbeef'.repeat(5), data: Buffer.from('test'), size: 4 }]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('OID mismatch'))
  }
})

// --- Write tests (real git dir) ---

test('toDisk writes a blob object', async (t) => {
  const dir = await createGitDir(t)
  const data = Buffer.from('hello world')
  const oid = await computeOid('blob', data)

  await toDisk({
    gitDir: join(dir, '.git'),
    objects: [{ type: 'blob', id: oid, data, size: data.length }]
  })

  const objectPath = join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
  t.ok(existsSync(objectPath), 'object file written')

  // Verify git can read it back
  const content = gitExec(['cat-file', '-p', oid], { cwd: dir })
  t.is(content, 'hello world')
})

test('toDisk writes multiple objects', async (t) => {
  const dir = await createGitDir(t)

  const blob1 = Buffer.from('file one')
  const blob2 = Buffer.from('file two')
  const oid1 = await computeOid('blob', blob1)
  const oid2 = await computeOid('blob', blob2)

  await toDisk({
    gitDir: join(dir, '.git'),
    objects: [
      { type: 'blob', id: oid1, data: blob1, size: blob1.length },
      { type: 'blob', id: oid2, data: blob2, size: blob2.length }
    ]
  })

  const content1 = gitExec(['cat-file', '-p', oid1], { cwd: dir })
  const content2 = gitExec(['cat-file', '-p', oid2], { cwd: dir })
  t.is(content1, 'file one')
  t.is(content2, 'file two')
})

test('toDisk writes a commit object', async (t) => {
  const dir = await createGitDir(t)

  // First write a blob + tree so we can make a valid commit
  const blobData = Buffer.from('readme content')
  const blobOid = await computeOid('blob', blobData)

  const { GitTree } = require('rebuild-git')
  const tree = new GitTree([{ mode: '100644', path: 'README.md', oid: blobOid, type: 'blob' }])
  const treeData = tree.toObject()
  const treeOid = await computeOid('tree', treeData)

  const commitText = [
    `tree ${treeOid}`,
    'author Test <test@test.com> 1700000000 +0000',
    'committer Test <test@test.com> 1700000000 +0000',
    '',
    'test commit'
  ].join('\n')
  const commitData = Buffer.from(commitText)
  const commitOid = await computeOid('commit', commitData)

  await toDisk({
    gitDir: join(dir, '.git'),
    objects: [
      { type: 'blob', id: blobOid, data: blobData, size: blobData.length },
      { type: 'tree', id: treeOid, data: treeData, size: treeData.length },
      { type: 'commit', id: commitOid, data: commitData, size: commitData.length }
    ]
  })

  const commitInfo = gitExec(['cat-file', '-p', commitOid], { cwd: dir })
  t.ok(commitInfo.includes('test commit'), 'commit message present')
  t.ok(commitInfo.includes(`tree ${treeOid}`), 'tree ref present')
})

test('toDisk is idempotent', async (t) => {
  const dir = await createGitDir(t)
  const data = Buffer.from('idempotent')
  const oid = await computeOid('blob', data)

  const obj = { type: 'blob', id: oid, data, size: data.length }

  await toDisk({ gitDir: join(dir, '.git'), objects: [obj] })
  await toDisk({ gitDir: join(dir, '.git'), objects: [obj] })

  const content = gitExec(['cat-file', '-p', oid], { cwd: dir })
  t.is(content, 'idempotent')
})

// --- Refs tests ---

test('toDisk writes refs', async (t) => {
  const dir = await createGitDir(t)
  const data = Buffer.from('ref test')
  const blobOid = await computeOid('blob', data)

  const { GitTree } = require('rebuild-git')
  const tree = new GitTree([{ mode: '100644', path: 'file.txt', oid: blobOid, type: 'blob' }])
  const treeData = tree.toObject()
  const treeOid = await computeOid('tree', treeData)

  const commitText = [
    `tree ${treeOid}`,
    'author Test <test@test.com> 1700000000 +0000',
    'committer Test <test@test.com> 1700000000 +0000',
    '',
    'ref commit'
  ].join('\n')
  const commitData = Buffer.from(commitText)
  const commitOid = await computeOid('commit', commitData)

  await toDisk({
    gitDir: join(dir, '.git'),
    objects: [
      { type: 'blob', id: blobOid, data, size: data.length },
      { type: 'tree', id: treeOid, data: treeData, size: treeData.length },
      { type: 'commit', id: commitOid, data: commitData, size: commitData.length }
    ],
    refs: { 'refs/heads/main': commitOid }
  })

  const refContent = readFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'utf8').trim()
  t.is(refContent, commitOid)

  const resolved = gitExec(['rev-parse', 'refs/heads/main'], { cwd: dir }).trim()
  t.is(resolved, commitOid)
})

test('toDisk writes HEAD as symbolic ref', async (t) => {
  const dir = await createGitDir(t)
  const data = Buffer.from('head test')
  const blobOid = await computeOid('blob', data)

  await toDisk({
    gitDir: join(dir, '.git'),
    objects: [{ type: 'blob', id: blobOid, data, size: data.length }],
    head: 'main'
  })

  const headContent = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
  t.is(headContent, 'ref: refs/heads/main')
})

test('toDisk writes refs and HEAD together', async (t) => {
  const dir = await createGitDir(t)
  const data = Buffer.from('full test')
  const blobOid = await computeOid('blob', data)

  const { GitTree } = require('rebuild-git')
  const tree = new GitTree([{ mode: '100644', path: 'file.txt', oid: blobOid, type: 'blob' }])
  const treeData = tree.toObject()
  const treeOid = await computeOid('tree', treeData)

  const commitText = [
    `tree ${treeOid}`,
    'author Test <test@test.com> 1700000000 +0000',
    'committer Test <test@test.com> 1700000000 +0000',
    '',
    'full commit'
  ].join('\n')
  const commitData = Buffer.from(commitText)
  const commitOid = await computeOid('commit', commitData)

  await toDisk({
    gitDir: join(dir, '.git'),
    objects: [
      { type: 'blob', id: blobOid, data, size: data.length },
      { type: 'tree', id: treeOid, data: treeData, size: treeData.length },
      { type: 'commit', id: commitOid, data: commitData, size: commitData.length }
    ],
    refs: { 'refs/heads/main': commitOid },
    head: 'main'
  })

  // HEAD points to main
  const headContent = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
  t.is(headContent, 'ref: refs/heads/main')

  // main resolves to commit
  const resolved = gitExec(['rev-parse', 'HEAD'], { cwd: dir }).trim()
  t.is(resolved, commitOid)

  // Can read the tree via HEAD
  const treeFromHead = gitExec(['cat-file', '-p', 'HEAD^{tree}'], { cwd: dir })
  t.ok(treeFromHead.includes('file.txt'))
})
