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
const objects = await remote.getRefObjects(commitOid)
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

Write git objects directly to a `.git` directory on disk.

```js
const { toDisk } = require('gip-remote/lib/git')

const objects = await remote.getRefObjects(commitOid)

await toDisk({
  gitDir: '/path/to/repo/.git',
  objects,
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

#### `await remote.push(branch, commitOid, objects)`

Push a commit. `objects` is a `Map<oid, { type, size, data }>`.

#### `await remote.getAllRefs()`

Returns an array of `{ ref, oid }`.

#### `await remote.getBranchRef(branch)`

Returns `{ ref, oid }` or `null`.

#### `await remote.getRefObjects(commitOid)`

Returns all stored objects for a commit.

#### `await remote.getObject(oid)`

Get a single object by OID.

#### `const drive = await remote.toDrive(branch)`

Returns a `RemoteDrive` or `null` if the branch doesn't exist. The drive is compatible with `mirror-drive`.

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

Write git objects to a `.git` directory.

- `opts.gitDir` - path to the `.git` directory (required)
- `opts.objects` - array of `{ type, id, size, data }` (required)
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
