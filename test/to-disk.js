const test = require('brittle')
const tmp = require('test-tmp')
const { spawnSync } = require('child_process')
const { existsSync, readFileSync, readdirSync, mkdirSync } = require('fs')
const { join } = require('path')
const crypto = require('bare-crypto')
const b4a = require('b4a')
const git = require('./helpers/git')

const { toDisk } = require('../lib/git')

// --- Helpers ---

async function createGitDir(t) {
  const dir = await tmp(t)
  spawnSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

function computeOid(type, data) {
  const header = b4a.from(`${type} ${data.byteLength}\0`)
  return crypto.createHash('sha1').update(header).update(data).digest('hex')
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

  const treeData = git.tree([{ mode: '100644', name: 'README.md', oid: blobOid }]).data
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

  const treeData = git.tree([{ mode: '100644', name: 'file.txt', oid: blobOid }]).data
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

  const treeData = git.tree([{ mode: '100644', name: 'file.txt', oid: blobOid }]).data
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

// --- Where things land ---

// A commit over `count` distinct blobs, as toDisk takes them
function history(count) {
  const blobs = []
  for (let i = 0; i < count; i++) blobs.push(git.blob('blob ' + i))
  const tree = git.tree(blobs.map((b, i) => ({ mode: '100644', name: `f${i}.txt`, oid: b.oid })))
  const commit = git.commit({ tree: tree.oid })
  const objects = [...blobs, tree, commit].map((o) => ({ ...o, id: o.oid }))
  return { commit, objects }
}

function fsck(gitDir) {
  const result = spawnSync('git', ['--git-dir', gitDir, 'fsck', '--strict', '--no-dangling'])
  return result.status === 0 ? '' : result.stderr.toString() || 'git fsck failed'
}

function leftovers(dir) {
  return readdirSync(dir, { recursive: true }).filter((name) => name.includes('tmp_'))
}

for (const count of [3, 500]) {
  const how = count < 100 ? 'loose' : 'packed'

  test(`toDisk writes into a bare repository, ${how}`, async (t) => {
    const dir = await tmp(t)
    const bare = join(dir, 'repo.git')
    gitExec(['init', '--bare', bare])
    const { commit, objects } = history(count)

    await toDisk({ gitDir: bare, objects, refs: { 'refs/heads/main': commit.oid } })

    t.absent(existsSync(join(dir, '.git')), 'nothing beside the repository')
    t.absent(existsSync(join(bare, '.git')), 'nothing nested in it')
    t.is(fsck(bare), '')
    t.is(gitExec(['--git-dir', bare, 'rev-parse', 'main']).trim(), commit.oid)
    t.is(
      gitExec(['--git-dir', bare, 'rev-list', '--objects', 'main']).split('\n').length - 1,
      count + 2
    )
    t.alike(leftovers(bare), [], 'no temporary files left')
    t.is(readdirSync(join(bare, 'objects', 'pack')).length, how === 'packed' ? 2 : 0)
  })

  test(`toDisk follows a .git file to a separate git dir, ${how}`, async (t) => {
    const dir = await tmp(t)
    const work = join(dir, 'work')
    const elsewhere = join(dir, 'elsewhere')
    gitExec(['init', '--separate-git-dir', elsewhere, work])
    const { commit, objects } = history(count)

    await toDisk({ gitDir: elsewhere, objects })
    t.is(fsck(elsewhere), '', 'given the git dir')
    t.is(gitExec(['cat-file', '-t', commit.oid], { cwd: work }).trim(), 'commit')

    const more = history(count + 1)
    await toDisk({ gitDir: join(work, '.git'), objects: more.objects })
    t.is(
      gitExec(['cat-file', '-t', more.commit.oid], { cwd: work }).trim(),
      'commit',
      'given the .git file'
    )
    t.ok(
      readFileSync(join(work, '.git'), 'utf8').startsWith('gitdir: '),
      'the .git file stays a file'
    )
  })

  test(`toDisk writes a linked worktree's objects and refs to the common dir, ${how}`, async (t) => {
    const dir = await tmp(t)
    const main = join(dir, 'main')
    const linked = join(dir, 'linked')
    mkdirSync(main)
    gitExec(['init', '-b', 'main'], { cwd: main })
    gitExec(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'base'],
      {
        cwd: main
      }
    )
    gitExec(['worktree', 'add', '-b', 'side', linked], { cwd: main })
    const gitDir = gitExec(['rev-parse', '--absolute-git-dir'], { cwd: linked }).trim()
    t.ok(gitDir.includes('worktrees'), 'GIT_DIR of a linked worktree')
    const { commit, objects } = history(count)

    await toDisk({ gitDir, objects, refs: { 'refs/heads/fetched': commit.oid } })

    t.absent(existsSync(join(gitDir, 'objects')), 'no objects in the worktree git dir')
    t.absent(existsSync(join(gitDir, 'refs', 'heads')), 'no branches there either')
    t.is(gitExec(['rev-parse', 'fetched'], { cwd: linked }).trim(), commit.oid)
    t.is(gitExec(['rev-parse', 'fetched'], { cwd: main }).trim(), commit.oid)
    t.is(fsck(join(main, '.git')), '')
  })
}

test('toDisk never leaves a partial object when an object is bad', async (t) => {
  for (const count of [3, 500]) {
    const dir = await createGitDir(t)
    const { objects } = history(count)
    objects[objects.length - 1] = { ...objects[objects.length - 1], id: 'deadbeef'.repeat(5) }

    await t.exception(toDisk({ gitDir: join(dir, '.git'), objects }), /OID mismatch/)
    t.alike(leftovers(join(dir, '.git')), [], 'no temporary files left')
    t.is(fsck(join(dir, '.git')), '', 'what is there is whole')
  }
})

test('toDisk writes trees byte for byte', async (t) => {
  const dir = await createGitDir(t)
  const blob = git.blob('x')
  const tree = git.tree([
    { mode: '100664', name: 'a', oid: blob.oid },
    { mode: '040000', name: 'b', oid: git.tree([]).oid }
  ])
  const objects = [blob, git.tree([]), tree].map((o) => ({ ...o, id: o.oid }))

  await toDisk({ gitDir: join(dir, '.git'), objects })
  const raw = spawnSync('git', ['cat-file', 'tree', tree.oid], { cwd: dir })
  t.ok(b4a.equals(raw.stdout, tree.data))
})

test('toDisk takes an async iterable and packs it as it comes', async (t) => {
  const dir = await tmp(t)
  const bare = join(dir, 'repo.git')
  gitExec(['init', '--bare', bare])
  const { commit, objects } = history(500)

  async function* stream() {
    // `oid` is as good as `id`
    for (const { oid, type, size, data } of objects) yield { oid, type, size, data }
  }
  await toDisk({ gitDir: bare, objects: stream(), refs: { 'refs/heads/main': commit.oid } })

  t.is(fsck(bare), '')
  t.is(gitExec(['--git-dir', bare, 'rev-list', '--objects', 'main']).split('\n').length - 1, 502)
  t.is(readdirSync(join(bare, 'objects', 'pack')).length, 2, 'one pack and its index')
  t.alike(leftovers(bare), [])

  async function* few() {
    yield* history(3).objects
  }
  await toDisk({ gitDir: bare, objects: few() })
  t.is(readdirSync(join(bare, 'objects', 'pack')).length, 2, 'a few objects stay loose')
  t.is(fsck(bare), '')

  async function* none() {}
  await toDisk({ gitDir: bare, objects: none() })
  t.is(fsck(bare), '', 'an empty stream writes nothing')
})

test('toDisk writes an object that comes in chunks without joining it', async (t) => {
  const dir = await tmp(t)
  const bare = join(dir, 'repo.git')
  gitExec(['init', '--bare', bare])

  const data = b4a.alloc(3 * 1024 * 1024 + 123)
  for (let i = 0; i < data.byteLength; i++) data[i] = (i * 31 + (i >> 9)) % 251
  const blob = git.blob(data)
  const empty = git.blob('')

  async function* chunks(size) {
    for (let i = 0; i < data.byteLength; i += size) yield data.subarray(i, i + size)
  }
  async function* none() {}
  const chunked = (size) => [
    { id: blob.oid, type: 'blob', size: blob.size, chunks: chunks(size) },
    { id: empty.oid, type: 'blob', size: 0, chunks: none() }
  ]

  await toDisk({ gitDir: bare, objects: chunked(1024 * 1024) })
  t.is(fsck(bare), '')
  const out = spawnSync('git', ['--git-dir', bare, 'cat-file', 'blob', blob.oid], {
    maxBuffer: data.byteLength * 2
  })
  t.ok(b4a.equals(out.stdout, data), 'git reads back the same bytes')
  t.is(gitExec(['--git-dir', bare, 'cat-file', '-s', empty.oid]).trim(), '0')

  const short = [{ id: blob.oid, type: 'blob', size: blob.size + 1, chunks: chunks(65536) }]
  await t.exception(toDisk({ gitDir: bare, objects: short }), /Size mismatch/)
  const wrong = [{ id: 'deadbeef'.repeat(5), type: 'blob', size: blob.size, chunks: chunks(65536) }]
  await t.exception(toDisk({ gitDir: bare, objects: wrong }), /OID mismatch/)
  t.alike(leftovers(bare), [], 'a bad object leaves nothing behind')
})
