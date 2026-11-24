import { Readable } from 'streamx'

interface RemoteOpts {
  timeout?: number
  blind?: any
}

interface Version {
  fork: number
  length: number
}

type RemoteLink =
  | string
  | { name: string; key?: Buffer; fork?: number | null; length?: number }
  | { drive: { key: Buffer; fork?: number | null; length?: number }; pathname?: string }

interface GitObject {
  oid: string
  type: string
  size: number
  data: Buffer
}

interface Ref {
  ref: string
  oid: string
  symref?: string
  peeled?: string
}

type PushObject = { type: string; size: number; data: Buffer }
type PushedObject = {
  oid: string
  type: string
  size: number
  data?: Buffer | null
  chunks?: AsyncIterable<Buffer> | Iterable<Buffer>
}
type PushObjects = Map<string, PushObject> | Iterable<PushedObject> | AsyncIterable<PushedObject>

interface RefOpts {
  expect?: string | null
}

interface RemoteError extends Error {
  code: 'STALE_REF' | 'UNSUPPORTED_REF' | 'MISSING_OBJECTS' | 'DELETE_HEAD'
  expected?: string | null
  actual?: string | null
  missing?: string[]
}

interface RefObject extends GitObject {
  id: string
}

// As refObjects yields them: a blob over 8 MiB has `chunks` and no `data`
interface StreamedObject {
  id: string
  oid: string
  type: string
  size: number
  data: Buffer | null
  chunks?: AsyncIterable<Buffer>
}

declare class Remote {
  constructor(store: any, link: RemoteLink, opts?: RemoteOpts)

  readonly name: string
  readonly core: any
  readonly key: Buffer
  readonly discoveryKey: Buffer
  readonly availablePeers: number
  readonly url: string
  readonly version: Version | null
  readonly pinned: boolean

  ready(): Promise<void>
  close(): Promise<void>

  push(name: string, oid: string, objects: PushObjects, opts?: RefOpts): Promise<void>
  pushRef(ref: string, oid: string, objects: PushObjects, opts?: RefOpts): Promise<void>
  deleteRef(ref: string, opts?: RefOpts): Promise<boolean>

  getHead(): Promise<string | null>
  setHead(branch: string): Promise<void>

  getAllRefs(): Promise<Ref[]>
  getBranchRef(branch: string): Promise<Ref | null>
  deleteBranch(branchName: string): Promise<boolean>
  deleteTag(tagName: string): Promise<boolean>

  getObject(oid: string): Promise<GitObject | null>
  getRefObjects(
    oid: string,
    onLoad?: ((size: number) => void) | null,
    opts?: { seen?: Set<string> }
  ): Promise<RefObject[]>

  refObjects(oid: string, opts?: { seen?: Set<string> }): AsyncIterableIterator<StreamedObject>

  toDrive(name: string): Promise<RemoteDrive | null>

  update(): Promise<void>
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

interface ParsedGitPearLink {
  protocol: string
  origin: string
  pathname?: string
  drive: {
    key: Buffer
    length: number
    fork?: number | null
  }
}

declare const GitPearLink: {
  parse(link: string): ParsedGitPearLink
  serialize(o: ParsedGitPearLink): string
}

type DiskObject = {
  id?: string
  oid?: string
  type: string
  size: number
  data?: Buffer | null
  chunks?: AsyncIterable<Buffer> | Iterable<Buffer>
}

interface ToDiskOpts {
  gitDir: string
  objects:
    | Array<{ type: string; id: string; size: number; data: Buffer }>
    | Iterable<DiskObject>
    | AsyncIterable<DiskObject>
  refs?: Record<string, string>
  head?: string
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

export { Remote, RemoteDrive, GitPearLink, toDisk, parseCommit, walkTree }
export type {
  RemoteOpts,
  RemoteLink,
  Version,
  GitObject,
  Ref,
  RefObject,
  StreamedObject,
  RefOpts,
  RemoteError,
  PushObjects,
  DriveEntry,
  ParsedGitPearLink,
  ToDiskOpts,
  Commit,
  FileEntry
}
