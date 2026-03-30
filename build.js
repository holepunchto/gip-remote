const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = 'schema/hyperschema'
const DB_DIR = 'schema/hyperdb'

{
  const schema = Hyperschema.from(SCHEMA_DIR)
  const ns = schema.namespace('gip')

  ns.register({
    name: 'repos',
    compact: true,
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'key', type: 'buffer', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'lastPushed', type: 'uint', required: false }
    ]
  })

  // Branches: replaces the single 'refs' blob
  ns.register({
    name: 'branches',
    compact: true,
    fields: [
      { name: 'name', type: 'string', required: true }, // e.g. 'main'
      { name: 'commitOid', type: 'string', required: true }, // HEAD commit
      { name: 'treeOid', type: 'string', required: true }, // root tree of HEAD
      { name: 'author', type: 'string', required: false }, // last commit author
      { name: 'message', type: 'string', required: false }, // last commit message
      { name: 'timestamp', type: 'uint', required: false }, // last commit timestamp
      { name: 'objects', type: 'string', array: true } // all OIDs for rebuild
    ]
  })

  // Files: path-indexed, one per file per branch
  ns.register({
    name: 'files',
    compact: true,
    fields: [
      { name: 'branch', type: 'string', required: true },
      { name: 'path', type: 'string', required: true }, // e.g. '/src/index.js'
      { name: 'oid', type: 'string', required: true }, // blob OID
      { name: 'mode', type: 'string', required: true }, // '100644', '100755', '120000'
      { name: 'size', type: 'uint', required: true },
      { name: 'author', type: 'string', required: false }, // last author to change this file
      { name: 'message', type: 'string', required: false }, // last commit message for this file
      { name: 'timestamp', type: 'uint', required: false } // last changed timestamp
    ]
  })

  // HEAD: singleton storing the default branch name
  ns.register({
    name: 'head',
    compact: true,
    fields: [
      { name: 'branch', type: 'string', required: true } // e.g. 'main'
    ]
  })

  // Git objects: raw blobs, trees, commits, tags
  ns.register({
    name: 'object-type',
    enum: ['blob', 'tree', 'commit', 'tag'],
    strings: true
  })

  ns.register({
    name: 'objects',
    compact: true,
    fields: [
      { name: 'oid', type: 'string', required: true },
      { name: 'type', type: '@gip/object-type', required: true },
      { name: 'size', type: 'uint', required: true },
      { name: 'data', type: 'buffer', required: true }
    ]
  })

  Hyperschema.toDisk(schema)
}

// --- HyperDB collection definitions ---

{
  const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
  const ns = db.namespace('gip')

  ns.collections.register({
    name: 'repos',
    schema: '@gip/repos',
    key: ['name']
  })

  ns.collections.register({
    name: 'branches',
    schema: '@gip/branches',
    key: ['name']
  })

  ns.collections.register({
    name: 'files',
    schema: '@gip/files',
    key: ['branch', 'path']
  })

  ns.collections.register({
    name: 'objects',
    schema: '@gip/objects',
    key: ['oid']
  })

  ns.collections.register({
    name: 'head',
    schema: '@gip/head',
    key: []
  })

  // List files by path prefix within a branch (directory listing)
  ns.indexes.register({
    name: 'files-by-branch',
    collection: '@gip/files',
    key: ['branch']
  })

  HyperDB.toDisk(db)
}
