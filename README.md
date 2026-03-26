# gip-remote

Git-into-Pear remote database. Store and replicate p2p Git repositories [HyperDB](https://github.com/holepunchto/hyperdb).

Git objects are stored raw, and rebuilt to file when needed. Built for the [Git+Pear remote transport](https://github.com/holepunchto/git-remote-punch-transport).

```
npm install gip-remote
```

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
const remote2 = new Remote(store.namespace('my-other-repo'), 'git+pear://0.1.iain5rkqfenyjrcod53tb61cq3egpwbk6cnd15ca3pqm39g7wf1y/my-other-repo')
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

#### `await toDisk(opts)`

Write git objects to a `.git` directory.

- `opts.gitDir` - path to the `.git` directory (required)
- `opts.objects` - array of `{ type, id, size, data }` (required)
- `opts.refs` - object mapping ref names to OIDs, e.g. `{ 'refs/heads/main': commitOid }`
- `opts.head` - branch name to set HEAD to, e.g. `'main'`
- `opts.objectFormat` - hash algorithm, only `'sha1'` supported (default)
- `opts.verifySizes` - verify declared sizes match buffer lengths (default `true`)

## License

Apache-2.0
