import { Readable } from 'streamx'

interface RemoteOpts {
  timeout?: number
  blind?: any
}

type RemoteLink =
  | string
  | { name: string; key?: Buffer }
  | { drive: { key: Buffer }; pathname?: string }

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
}

interface RefObject extends GitObject {
  id: string
}

declare class Remote {
  constructor(store: any, link: RemoteLink, opts?: RemoteOpts)

  readonly name: string
  readonly core: any
  readonly key: Buffer
  readonly discoveryKey: Buffer
  readonly availablePeers: number
  readonly url: string

  ready(): Promise<void>
  close(): Promise<void>

  push(
    branch: string,
    commitOid: string,
    objects: Map<string, { type: string; size: number; data: Buffer }>
  ): Promise<void>

  getHead(): Promise<string | null>
  setHead(branch: string): Promise<void>

  getAllRefs(): Promise<Ref[]>
  getBranchRef(branch: string): Promise<Ref | null>
  deleteBranch(branchName: string): Promise<boolean>

  getObject(oid: string): Promise<GitObject | null>
  getRefObjects(commitOid: string, onLoad?: (size: number) => void): Promise<RefObject[]>

  toDrive(branch: string): Promise<RemoteDrive | null>

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

interface ToDiskOpts {
  gitDir: string
  objects: Array<{ type: string; id: string; size: number; data: Buffer }>
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
  GitObject,
  Ref,
  RefObject,
  DriveEntry,
  ParsedGitPearLink,
  ToDiskOpts,
  Commit,
  FileEntry
}
