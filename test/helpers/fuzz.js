const test = require('brittle')
const Corestore = require('corestore')
const b4a = require('b4a')
const env = require('bare-env')
const tmp = require('test-tmp')
const { join } = require('path')
const { promises: fs } = require('fs')
const { Remote } = require('../..')
const Model = require('./model')
const git = require('./git')

// Known bugs the fuzz would otherwise trip over on every seed. Each is pinned
// by a `bug` test, which is a todo until GIP_STRICT=1 stops tolerating them.
const KNOWN = env.GIP_STRICT
  ? {}
  : { thinPushFileSize: true, astralFolderList: true, cancelledReads: true }
const bug = env.GIP_STRICT ? test : test.todo

const BRANCHES = [
  'main',
  'main2',
  'dev',
  'feature',
  'feature/x',
  'v1',
  'HEAD',
  'refs/notes/commits',
  'ünï/日本語/😀',
  'long-' + 'n'.repeat(300)
]
const TAGS = ['v1', 'v1.0.0', 'x', 'main', 'tags/nested', 'ünï-😀']
const DIRS = ['', '', 'src/', 'src/lib/', 'docs/', '😀dir/', 'ü/']
const FILES = [
  'README.md',
  'a.txt',
  'b.js',
  'x y.txt',
  'ünï.txt',
  '😀.txt',
  '日本語',
  'f'.repeat(200)
]

function prng(seed) {
  let a = seed >>> 0
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  rng.int = (n) => Math.floor(rng() * n)
  rng.pick = (list) => list[rng.int(list.length)]
  rng.chance = (p) => rng() < p
  rng.bytes = (n) => {
    const buf = b4a.alloc(n)
    for (let i = 0; i < n; i++) buf[i] = rng.int(256)
    return buf
  }
  return rng
}

// A random but valid git object graph: real encodings, real SHA-1 oids.
function createUniverse(rng, opts = {}) {
  const { commits: commitCount = 12, tags: tagCount = 5 } = opts

  const objects = new Map()
  const meta = new Map()
  const labels = new Map()

  const add = (obj, m, label) => {
    if (!objects.has(obj.oid)) {
      objects.set(obj.oid, { type: obj.type, size: obj.size, data: obj.data })
      meta.set(obj.oid, { type: obj.type, ...m })
      labels.set(obj.oid, label + labels.size)
    }
    return obj.oid
  }

  const contents = [b4a.alloc(0), b4a.from('hello\n'), b4a.alloc(70000, 'compressible ')]
  const content = () => {
    if (rng.chance(0.5)) return rng.pick(contents)
    const data = rng.chance(0.1) ? rng.bytes(40000) : rng.bytes(1 + rng.int(64))
    contents.push(data)
    return data
  }
  const addBlob = (data) => add(git.blob(data), {}, 'blob')

  const mutate = (files) => {
    const paths = [...files.keys()]
    const kind = rng.int(8)

    if (kind <= 3 || paths.length === 0) {
      const path = rng.pick(DIRS) + rng.pick(FILES)
      for (const p of paths) {
        if (p.startsWith(path + '/') || path.startsWith(p + '/')) files.delete(p)
      }
      const mode = rng.pick(['100644', '100644', '100644', '100755', '120000', '160000'])
      if (mode === '160000') files.set(path, { mode, oid: b4a.toString(rng.bytes(20), 'hex') })
      else if (mode === '120000') files.set(path, { mode, oid: addBlob(b4a.from('a.txt')) })
      else files.set(path, { mode, oid: addBlob(content()) })
    } else if (kind === 4) {
      files.delete(rng.pick(paths))
    } else if (kind === 5) {
      const path = rng.pick(paths)
      const file = files.get(path)
      if (file.mode === '100644') files.set(path, { ...file, mode: '100755' })
      else if (file.mode === '100755') files.set(path, { ...file, mode: '100644' })
    } else if (kind === 6) {
      const path = rng.pick(paths)
      const file = files.get(path)
      if (file.mode.startsWith('100')) files.set(path, { ...file, oid: addBlob(content()) })
    } else {
      files.clear()
    }
  }

  const addTree = (files) => {
    const blobs = []
    const dirs = new Map()
    for (const [path, file] of files) {
      const i = path.indexOf('/')
      if (i === -1) {
        blobs.push({ mode: file.mode, name: path, oid: file.oid })
        continue
      }
      const dir = path.slice(0, i)
      if (!dirs.has(dir)) dirs.set(dir, new Map())
      dirs.get(dir).set(path.slice(i + 1), file)
    }
    const entries = blobs
    for (const [name, sub] of dirs) entries.push({ mode: '40000', name, oid: addTree(sub) })
    return add(git.tree(entries), { entries }, 'tree')
  }

  const commits = []
  for (let i = 0; i < commitCount; i++) {
    const parents = []
    if (commits.length > 0 && !rng.chance(0.15)) {
      const count = rng.chance(0.2) ? 2 + rng.int(2) : 1
      const recent = Math.max(0, commits.length - 3)
      parents.push(commits[recent + rng.int(commits.length - recent)])
      while (parents.length < count) {
        const parent = rng.pick(commits)
        if (!parents.includes(parent)) parents.push(parent)
        else break
      }
    }

    const base = parents.length > 0 && rng.chance(0.15) ? rng.pick(commits) : parents[0]
    const files = new Map(base ? base.files : [])
    for (let n = rng.int(4); n > 0; n--) mutate(files)

    const treeOid = addTree(files)
    const oid = add(
      git.commit({
        tree: treeOid,
        parents: parents.map((p) => p.oid),
        time: 1700000000 + i * 60,
        message: rng.pick(['change', 'fix: ünï 😀', 'multi\n\nline body'])
      }),
      { tree: treeOid, parents: parents.map((p) => p.oid) },
      'commit'
    )
    commits.push({ oid, files })
  }

  const tags = []
  for (let i = 0; i < tagCount; i++) {
    const kind = rng.int(10)
    let target = rng.pick(commits).oid
    if (kind === 0 && tags.length > 0) target = rng.pick(tags)
    else if (kind === 1) target = rng.pick([...objects.keys()])

    const type = objects.get(target).type
    const tagOid = add(
      git.tag({ object: target, type, name: 'tag-' + i, time: 1700000000 + i }),
      { object: target },
      'tag'
    )
    tags.push(tagOid)
  }

  const all = new Model(meta)
  all.objects = objects

  return {
    objects,
    meta,
    commits: commits.map((c) => c.oid),
    tags,
    label: (oid) => labels.get(oid) ?? oid.slice(0, 7),
    closure: (oid, seen) => all.closure(oid, seen),
    parents(oid) {
      let m = meta.get(oid)
      while (m && m.type === 'tag') m = meta.get(m.object)
      return m && m.type === 'commit' ? m.parents : []
    }
  }
}

function createScript(rng, u, length, opts = {}) {
  const { mutationsOnly = false, shallow = 0.1 } = opts
  const oids = [...u.objects.keys()]

  const push = () => {
    const ref = rng.chance(0.7) ? rng.pick(BRANCHES) : 'tags/' + rng.pick(TAGS)
    const roll = rng.int(20)
    let oid = rng.pick(u.commits)
    let from = oid
    if (roll < 4) oid = from = rng.pick(u.tags)
    else if (roll === 4) oid = from = rng.pick(oids)
    else if (roll === 5) oid = b4a.toString(rng.bytes(20), 'hex')
    return {
      type: 'push',
      ref,
      oid,
      from,
      thin: rng.pick([0, 0.5, 1, 1]),
      shallow: rng.chance(shallow),
      salt: rng.int(2 ** 31)
    }
  }

  const mutation = () => {
    const roll = rng.int(10)
    if (roll < 6) return push()
    if (roll < 8) return { type: 'deleteBranch', name: rng.pick(BRANCHES) }
    if (roll < 9) return { type: 'deleteTag', name: rng.pick(TAGS) }
    return { type: 'setHead', name: rng.pick(BRANCHES) }
  }

  const script = []
  while (script.length < length) {
    const roll = mutationsOnly ? 0 : rng.int(20)
    if (roll < 14) script.push(mutation())
    else if (roll < 17) script.push({ type: 'fetch', extra: rng.pick(oids) })
    else if (roll < 18) script.push({ type: 'reopen' })
    else script.push({ type: 'concurrent', ops: [mutation(), mutation(), mutation()] })
  }
  return script
}

function generate(seed, opts = {}) {
  const rng = prng(seed)
  const universe = createUniverse(rng, opts)
  const script = createScript(rng, universe, opts.length ?? 40, opts)
  return { universe, script }
}

function describe(u, op) {
  switch (op.type) {
    case 'push':
      return `push ${JSON.stringify(op.ref)} ${u.label(op.oid)} thin=${op.thin}${op.shallow ? ' shallow' : ''}`
    case 'deleteBranch':
    case 'deleteTag':
    case 'setHead':
      return `${op.type} ${JSON.stringify(op.name)}`
    case 'fetch':
      return `fetch all refs with a shared seen, then ${u.label(op.extra)}`
    case 'concurrent':
      return `concurrent [${op.ops.map((o) => describe(u, o)).join(', ')}]`
    default:
      return op.type
  }
}

// The objects a client would send: the tip's closure, minus (some of) what
// the remote already has when the push is thin, and without the tip commit's
// ancestors when it is shallow.
function pack(model, u, op) {
  const rng = prng(op.salt)
  const objects = new Map()
  for (const oid of u.closure(op.from, new Set(op.shallow ? u.parents(op.from) : []))) {
    if (model.objects.has(oid) && rng() < op.thin) continue
    objects.set(oid, u.objects.get(oid))
  }
  return objects
}

function check(ok, message) {
  if (!ok) throw new Error(message)
}

function same(actual, expected, message) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(a === e, `${message}: got ${a}, expected ${e}`)
}

function settle(fn) {
  try {
    return { value: fn() }
  } catch (err) {
    return { err }
  }
}

// Apply one mutation to the model, returning what the Remote must answer.
function expect(model, u, op) {
  switch (op.type) {
    case 'push': {
      const objects = pack(model, u, op)
      return { objects, ...settle(() => model.push(op.ref, op.oid, objects)) }
    }
    case 'deleteBranch':
      return { value: model.deleteBranch(op.name) }
    case 'deleteTag':
      return { value: model.deleteTag(op.name) }
    case 'setHead':
      return { value: model.setHead(op.name) }
  }
}

async function mutate(remote, u, op, expected) {
  let actual
  try {
    if (op.type === 'push') {
      actual = { value: await remote.push(op.ref, op.oid, new Map(expected.objects)) }
    } else if (op.type === 'setHead') {
      actual = { value: void (await remote.setHead(op.name)) }
    } else {
      actual = { value: await remote[op.type](op.name) }
    }
  } catch (err) {
    actual = { err }
  }

  const what = describe(u, op)
  if (expected.err) return check(actual.err, `${what} must throw (${expected.err.message})`)
  check(!actual.err, `${what} threw: ${actual.err && actual.err.stack}`)
  same(actual.value, expected.value, `${what} result`)
}

async function apply(remote, model, u, op) {
  await mutate(remote, u, op, expect(model, u, op))
}

async function fetch(remote, model, u, op) {
  const seen = new Set()
  const expectedSeen = new Set()
  const oids = [...model.tips(), op.extra, op.extra]

  for (const oid of oids) {
    let loaded = 0
    const objs = await remote.getRefObjects(oid, (size) => (loaded += size), { seen })
    const expected = model.getRefObjects(oid, expectedSeen)
    same(
      objs.map((o) => u.label(o.id)).sort(),
      expected.map(u.label).sort(),
      `getRefObjects(${u.label(oid)}, { seen })`
    )
    const size = expected.reduce((n, o) => n + model.objects.get(o).size, 0)
    check(loaded === size, `getRefObjects(${u.label(oid)}) onLoad total ${loaded} != ${size}`)
  }

  same([...seen].sort(), [...expectedSeen].sort(), 'seen after a multi-ref fetch')
}

async function collect(stream) {
  const out = []
  for await (const item of stream) out.push(item)
  return out
}

function sortRefs(refs) {
  return refs.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
}

function bytes(buf) {
  return buf || b4a.alloc(0)
}

async function compareDrive(remote, model, name) {
  const files = model.files(name)
  const drive = await remote.toDrive(name)
  const what = `drive ${JSON.stringify(name)}`
  if (!files) return check(drive === null, `${what} must be null`)
  check(drive !== null, `${what} is null`)

  const size = (path) => model.objects.get(files.get(path)?.oid)?.size ?? 0
  const indexed = model.branches.has(name)
  const sizeUnreliable = KNOWN.thinPushFileSize && indexed
  const view = (prefix) => {
    const out = []
    for (const [path, file] of files) {
      if (path.startsWith(prefix)) out.push([path, file.mode === '100755', size(path)])
    }
    return out.sort()
  }
  const listed = async (folder) => {
    const entries = await collect(drive.list(folder))
    return entries
      .map(({ key, value }) => {
        const byteLength = value.blob.byteLength
        return [key, value.executable, sizeUnreliable && byteLength === 0 ? size(key) : byteLength]
      })
      .sort()
  }
  const dirs = (prefix) => {
    const names = new Set()
    for (const path of files.keys()) {
      if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0])
    }
    return [...names].sort()
  }

  same(await listed('/'), view('/'), `${what} list('/')`)
  same((await collect(drive.readdir('/'))).sort(), dirs('/'), `${what} readdir('/')`)

  const folders = new Set()
  for (const [path, file] of files) {
    const stored = model.objects.get(file.oid)
    const data = await drive.get(path)
    if (!stored) check(data === null, `${what} get(${path}) must be null`)
    else {
      check(data !== null && b4a.equals(data, stored.data), `${what} get(${path}) bytes differ`)
    }

    const streamed = b4a.concat(await collect(drive.createReadStream(path)))
    check(
      b4a.equals(streamed, stored ? stored.data : b4a.alloc(0)),
      `${what} stream(${path}) differs`
    )

    const entry = await drive.entry(path)
    check(entry !== null && entry.key === path, `${what} entry(${path}) missing`)
    check(entry.value.executable === (file.mode === '100755'), `${what} entry(${path}) mode`)

    const parts = path.split('/')
    for (let i = 2; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }

  for (const folder of folders) {
    const prefix = folder + '/'
    const hidden = (path) =>
      indexed && KNOWN.astralFolderList && path.codePointAt(prefix.length) > 0xffff
    same(
      await listed(folder),
      view(prefix).filter(([path]) => !hidden(path)),
      `${what} list(${folder})`
    )
    same(
      (await collect(drive.readdir(folder))).sort(),
      dirs(prefix).filter((name) => !hidden(prefix + name)),
      `${what} readdir(${folder})`
    )
  }

  check((await drive.get('/nope')) === null, `${what} get of a missing path must be null`)
  check((await drive.entry('/nope')) === null, `${what} entry of a missing path must be null`)
}

// Every public read of the Remote against the model. `opts.refObjects: false`
// leaves getRefObjects out, for replicas it would break (KNOWN.cancelledReads).
async function compare(remote, model, u, opts = {}) {
  same(sortRefs(await remote.getAllRefs()), sortRefs(model.refs()), 'getAllRefs')
  same(await remote.getHead(), model.head, 'getHead')

  for (const name of BRANCHES) {
    const oid = model.branches.get(name)
    const expected = oid ? { ref: `refs/heads/${name}`, oid } : null
    same(await remote.getBranchRef(name), expected, `getBranchRef(${name})`)
  }

  for (const [oid, obj] of u.objects) {
    const got = await remote.getObject(oid)
    const what = `getObject(${u.label(oid)})`
    if (!model.objects.has(oid)) {
      check(got === null, `${what} must be null`)
      continue
    }
    check(got !== null, `${what} is missing`)
    same([got.oid, got.type, got.size], [oid, obj.type, obj.size], what)
    check(b4a.equals(bytes(got.data), obj.data), `${what} bytes differ`)
  }

  for (const oid of opts.refObjects === false ? [] : model.tips()) {
    const objs = await remote.getRefObjects(oid)
    same(
      objs.map((o) => u.label(o.id)).sort(),
      model.closure(oid).map(u.label).sort(),
      `getRefObjects(${u.label(oid)})`
    )
    for (const o of objs) {
      const obj = u.objects.get(o.id)
      check(
        o.type === obj.type && o.size === obj.size && b4a.equals(o.data, obj.data),
        `getRefObjects(${u.label(oid)}) returned a wrong ${u.label(o.id)}`
      )
    }
  }

  for (const name of new Set([...BRANCHES, ...TAGS])) await compareDrive(remote, model, name)
}

class Sut {
  constructor(dir) {
    this.dir = dir
    this.store = null
    this.remote = null
  }

  async open() {
    this.store = new Corestore(this.dir)
    this.remote = new Remote(this.store, 'model')
    await this.remote.ready()
  }

  async close() {
    await this.remote.close()
    await this.store.close()
  }
}

async function step(sut, model, u, op) {
  if (op.type === 'reopen') {
    await sut.close()
    await sut.open()
  } else if (op.type === 'fetch') {
    await fetch(sut.remote, model, u, op)
  } else if (op.type === 'concurrent') {
    const expected = op.ops.map((o) => expect(model, u, o))
    await Promise.all(op.ops.map((o, i) => mutate(sut.remote, u, o, expected[i])))
  } else {
    await apply(sut.remote, model, u, op)
  }
}

// Run a script against a fresh Remote in `dir`, comparing with the model
// after every step. Resolves to null, or to the first failure.
async function run(dir, u, script) {
  const sut = new Sut(dir)
  const model = new Model(u.meta)
  await sut.open()

  try {
    for (let i = 0; i < script.length; i++) {
      try {
        await step(sut, model, u, script[i])
        await compare(sut.remote, model, u)
      } catch (err) {
        return { step: i, err }
      }
    }
    return null
  } finally {
    await sut.close()
  }
}

// Delta-debug: drop ever smaller runs of ops while the script still fails.
async function shrink(script, attempt, budget = 120) {
  let failure = await attempt(script)
  script = script.slice(0, failure.step + 1)

  for (let size = script.length >> 1; size >= 1 && budget > 0; size >>= 1) {
    for (let i = 0; i + size <= script.length && budget > 0;) {
      const candidate = [...script.slice(0, i), ...script.slice(i + size)]
      budget--
      const f = await attempt(candidate)
      if (f) {
        failure = f
        script = candidate.slice(0, f.step + 1)
      } else {
        i += size
      }
    }
  }

  return { script, failure }
}

async function fuzz(t, seed, opts) {
  const { universe, script } = generate(seed, opts)
  const root = await tmp(t)
  let runs = 0

  const attempt = async (s) => {
    const dir = join(root, String(runs++))
    try {
      return await run(dir, universe, s)
    } finally {
      await fs.rm(dir, { recursive: true })
    }
  }

  if (!(await attempt(script))) return true

  const minimal = await shrink(script, attempt)
  const lines = minimal.script.map((op, i) => `  ${i}. ${describe(universe, op)}`)
  t.fail(
    `GIP_SEED=${seed} fails at step ${minimal.failure.step}: ${minimal.failure.err.message}\n` +
      `minimal script (${minimal.script.length} of ${script.length} ops):\n${lines.join('\n')}`
  )
  return false
}

module.exports = { KNOWN, bug, prng, generate, describe, expect, apply, compare, fuzz, Sut }
