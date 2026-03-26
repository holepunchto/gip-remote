import { Readable } from 'streamx'

interface RemoteOpts {
  name?: string
  store: any
  swarm: any
  key?: Buffer
  timeout?: number
  blind?: boolean
}

interface GitObject {
  oid: string
  type: string
  size: number
  data: Buffer
}

interface Ref {
  ref: string
  oid: string
}

interface RefObject extends GitObject {
  id: string
}

declare class Remote {
  constructor(opts: RemoteOpts)

  readonly name: string
  readonly core: any
  readonly key: Buffer
  readonly discoveryKey: Buffer
  readonly availablePeers: number

  ready(): Promise<void>
  close(): Promise<void>

  push(
    branch: string,
    commitOid: string,
    objects: Map<string, { type: string; size: number; data: Buffer }>
  ): Promise<void>
  getAllRefs(): Promise<Ref[]>
  getBranchRef(branch: string): Promise<Ref | null>
  getObject(oid: string): Promise<GitObject | null>
  getRefObjects(commitOid: string, onLoad?: (size: number) => void): Promise<RefObject[]>
  toDrive(branch: string): Promise<RemoteDrive | null>
  waitForPeers(): Promise<void>
}

interface DriveEntry {
  key: string
  value: {
    executable: boolean
    linkname: null
    blob: { byteLength: number }
    metadata: null
  }
}

declare class RemoteDrive {
  constructor(db: any, opts?: { branch?: string })

  ready(): Promise<void>

  entry(nameOrEntry: string | { key: string }): Promise<DriveEntry | null>
  get(nameOrEntry: string | { key: string }): Promise<Buffer | null>
  createReadStream(entryOrKey: string | { key: string }): Readable
  list(folder: string, opts?: { ignore?: (path: string) => boolean }): Readable
  readdir(folder: string): Readable
  mirror(out: any, opts?: any): any
}

interface ToDiskOpts {
  gitDir: string
  objects: Array<{ type: string; id: string; size: number; data: Buffer }>
  objectFormat?: 'sha1'
  fs?: any
  verifySizes?: boolean
}

declare function toDisk(opts: ToDiskOpts): Promise<void>

interface Commit {
  tree: string | null
  parents: string[]
  author: string | null
  timestamp: number
  message: string
}

interface FileEntry {
  path: string
  oid: string
  mode: string
  size: number
}

declare function parseCommit(data: Buffer): Commit
declare function walkTree(
  objects: Map<string, { type: string; size: number; data: Buffer }>,
  treeOid: string,
  prefix: string
): FileEntry[]

export { Remote, RemoteDrive, toDisk, parseCommit, walkTree }
