# gip-remote

Git-into-Pear remote database. Store and replicate p2p Git repositories [HyperDB](https://github.com/holepunchto/hyperdb).

Git objects are stored raw, and rebuilt to file when needed. Built for the [Git+Pear remote transport](https://github.com/holepunchto/git-remote-punch-transport).

```
npm install gip-remote
```

## Links

A `git+pear://` link addresses a repository. It uses the [Pear Link Format](https://github.com/holepunchto/pear-link) grammar and parser:

```
git+pear://[<fork>.<length>.]<key><path>[?<search>][#<hash>]
```

`<key>` is the repository's public key, z32 encoded. Keys are generated locally and resolve on the DHT, so the same link works from any machine. `<path>` is the repository name:

```
git+pear://z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/my-repo
```

`<fork>.<length>` pins a version — an immutable position in the append-only log, where `fork` is truncation count and `length` append count. A branch can be force-pushed and a tag removed; a versioned link always resolves to the same bytes:

```
git+pear://0.42.z17anrqrtwgjxpig3oiohoxr7m9eijz3acpytiay6xku8pdh68by/my-repo
```

Omit `<fork>.<length>` to follow latest.

`Remote` accepts a link string directly, and `remote.url` returns the current versioned link.

## Usage

```js
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Remote } = require('gip-remote')

const store = new Corestore('./my-store')
const swarm = new Hyperswarm()
swarm.on('connection', (conn) => {
  store.replicate(conn)
})

// new remote
const remote = new Remote(store.namespace('my-repo'), 'my-repo')
await remote.ready()

console.log(remote.key) // public key

// remote remote!
const remote2 = new Remote(
  store.namespace('my-other-repo'),
  'git+pear://0.1.iain5rkqfenyjrcod53tb61cq3egpwbk6cnd15ca3pqm39g7wf1y/my-other-repo'
)
await remote2.ready()
```

### Push

```js
// objects is a Map of oid => { type, size, data }
await remote.push('main', commitOid, objects)
```

### Fetch

```js
const refs = await remote.getAllRefs()

for await (const { oid, type, size, data } of remote.refObjects(commitOid)) {
  // ...
}
```

### toDrive

Get a Hyperdrive-compatible interface for a branch. Works with [mirror-drive](https://github.com/holepunchto/mirror-drive/).

```js
const drive = await remote.toDrive('main')

const content = await drive.get('/README.md')

for await (const path of drive.list('/')) {
  console.log(path)
}

// Mirror to a local Hyperdrive
const mirror = drive.mirror(localDrive)
await mirror.done()
```

### toDisk

Write git objects directly into a git dir on disk.

```js
const { toDisk } = require('gip-remote/lib/git')

await toDisk({
  gitDir: '/path/to/repo/.git',
  objects: remote.refObjects(commitOid),
  refs: { 'refs/heads/main': commitOid },
  head: 'main'
})
```

## API

#### `const remote = new Remote(opts)`

Create a new remote.

- `opts.name` - repository name
- `opts.store` - a Corestore instance
- `opts.swarm` - a Hyperswarm instance
- `opts.key` - optional public key to open an existing remote
- `opts.timeout` - peer discovery timeout in ms (default `240000`)

#### `remote.key`

Public key of the underlying Hypercore.

#### `remote.url`

Versioned `git+pear://` link for the remote at its current length.

#### `remote.discoveryKey`

Discovery key used for swarming.

#### `await remote.pushRef(ref, oid, objects, [opts])`

Store `objects` and point `ref` at `oid`. `ref` is a full ref name, `refs/heads/<name>` or `refs/tags/<name>`. A branch must point at a commit, a tag may point at any object.

`objects` is a `Map<oid, { type, size, data }>`, or an iterable or async iterable of `{ oid, type, size, data }`. It only needs to hold what the remote doesn't have yet. A blob may have `chunks`, an async iterable of buffers, instead of `data`: it is stored piece by piece and never held whole.

Objects are written as they come, a bounded batch at a time, so an async iterable is pushed in bounded memory. A final small transaction checks `opts.expect` and moves the ref. The ref is always either where it was, or at `oid` with everything `oid` reaches. A push that fails or is killed leaves at most objects that no ref points at; the next push reuses them.

- `opts.expect` - `null`: the ref must not exist yet. An oid: the ref must currently be at it. Left out: no check.

Rejects with an error whose `code` is:

- `STALE_REF` - the ref is not where `opts.expect` says (`err.expected`, `err.actual`)
- `UNSUPPORTED_REF` - the ref is outside `refs/heads/` and `refs/tags/`
- `MISSING_OBJECTS` - an object of the push links to something that is neither in the push nor in the store (`err.missing`), as a push from a shallow clone does

The first branch pushed becomes the head. Until the remote is closed, a push of `main`, else `master`, takes the head over from it. A head set with `setHead` stays.

#### `await remote.push(name, oid, objects, [opts])`

`pushRef` by short name: `name` is a branch name, or `tags/<name>` for a tag.

#### `const deleted = await remote.deleteRef(ref, [opts])`

Delete a branch or tag by full ref name. `opts.expect` as in `pushRef`. Rejects with code `DELETE_HEAD` for the head branch.

#### `await remote.deleteBranch(name)` / `await remote.deleteTag(name)`

Delete by short name, the head branch included.

#### `await remote.getHead()` / `await remote.setHead(branch)`

The branch `HEAD` points at.

#### `await remote.getAllRefs()`

Returns an array of `{ ref, oid }`. `HEAD` also has `symref`, and an annotated tag has `peeled`, the oid of the object it finally points at.

#### `await remote.getBranchRef(branch)`

Returns `{ ref, oid }` or `null`.

#### `for await (const obj of remote.refObjects(oid, [opts]))`

Every object reachable from `oid`, which must be the tip of a ref, as `{ id, oid, type, size, data }`. Objects are yielded as the walk reaches them, and only the oids seen are kept in memory.

A blob too large for one block (over 8 MiB) has `data: null` and `chunks`, an async iterable of its buffers. Both `pushRef` and `toDisk` take objects of this shape, so a fetch can be piped into either.

- `opts.seen` - a `Set` shared across calls: objects in it are left out, and the ones yielded are added

#### `await remote.getRefObjects(oid, [onLoad], [opts])`

`refObjects` collected into an array, with large blobs joined into `data`.

#### `await remote.getObject(oid)`

Get a single object by OID.

#### `const drive = await remote.toDrive(name)`

Returns a drive compatible with `mirror-drive`. `name` is a full ref name, or a short one: the branch of that name, else the tag. `null` if there is no such ref, or it is a tag of something other than a commit.

Tree entries whose name is not safe as a path (`.git`, `..`, names with a slash or backslash) are stored and fetched like any other, but left out of the drive.

A branch's drive reads the file index a push writes. The index of a very large change is written in several steps after the ref has moved; until the last one, the drive is served from the tree instead.

#### `GitPearLink.parse(link)`

Parse a `git+pear://` link. Returns:

```js
{
  protocol: 'git+pear:',
  origin: 'git+pear://<key>',
  pathname: '/my-repo',
  search: '',
  hash: '',
  drive: { key: Buffer, length: 42, fork: 0, hash: null }
}
```

Unversioned links give `length: -1` and `fork: null`. Throws on an invalid key. Any other protocol falls through to `pear-link`.

#### `GitPearLink.serialize(parsed)`

Serialize a parsed link back to a string.

```js
GitPearLink.serialize({
  protocol: 'git+pear:',
  pathname: '/my-repo',
  origin: GitPearLink.normalize(`git+pear://${z32.encode(key)}/my-repo`),
  drive: { key, length: 42, fork: 0 }
}) // git+pear://0.42.<key>/my-repo
```

#### `GitPearLink.normalize(link)`

Canonical string form of a link, as used for `origin`. Inherited from `pear-link`.

#### `await toDisk(opts)`

Write git objects into a git dir. Each file is written under a temporary name and renamed into place. Fewer than 100 objects are written loose, more as one pack, which is written as the objects come.

- `opts.gitDir` - the git dir itself (required): `repo/.git`, a bare repository, a linked worktree's git dir, or a `.git` file pointing at one
- `opts.objects` - array, iterable or async iterable of `{ type, id, size, data }` (required). `oid` is read when there is no `id`, and an object may have `chunks` instead of `data`, as `refObjects` yields them. A stream must not repeat an object.
- `opts.refs` - object mapping ref names to OIDs, e.g. `{ 'refs/heads/main': commitOid }`
- `opts.head` - branch name to set HEAD to, e.g. `'main'`
- `opts.objectFormat` - hash algorithm, only `'sha1'` supported (default)
- `opts.verifySizes` - verify declared sizes match buffer lengths (default `true`)

## Networking and seeding

`Remote` owns only the database — it does not manage the swarm or blind peering.
The caller is responsible for replication (`swarm.on('connection', (conn) => store.replicate(conn))`)
and, if seeding through blind peers, for adding the core to its `BlindPeering`
instance. The underlying core is exposed via `remote.core` for exactly this.

## Large objects

A single Hypercore block can't exceed ~15 MiB, so a git object larger than that
can't be stored as one record. Such objects are split across `@gip/object-chunks`
rows (8 MiB each) and reassembled transparently by `getObject`; the `@gip/objects`
row keeps the true `size` with an empty `data`. Objects under the limit are stored
inline as before, and chunks replicate over the same core as everything else.

## License

Apache-2.0
