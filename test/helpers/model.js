// Pure in-memory reference for Remote: refs, head and the object graph.
// `meta` describes how objects link (oid → { type, tree, parents, object,
// entries }), so nothing here parses git encodings.
module.exports = class Model {
  constructor(meta) {
    this.meta = meta
    this.objects = new Map()
    this.branches = new Map()
    this.tags = new Map()
    this.head = null
    // the branch this session made the head by default
    this.auto = null
  }

  clone() {
    const model = new Model(this.meta)
    model.objects = new Map(this.objects)
    model.branches = new Map(this.branches)
    model.tags = new Map(this.tags)
    model.head = this.head
    model.auto = this.auto
    return model
  }

  links(oid) {
    const m = this.meta.get(oid)
    if (m.type === 'tag') return [m.object]
    if (m.type === 'commit') return [m.tree, ...m.parents]
    if (m.type === 'tree') return m.entries.filter((e) => e.mode !== '160000').map((e) => e.oid)
    return []
  }

  // `ref` as Remote.push takes it: a branch name, or tags/<name>. The
  // objects land whether or not the ref then moves.
  push(ref, oid, objects) {
    for (const [o, obj] of objects) {
      if (!this.objects.has(o)) this.objects.set(o, obj)
    }

    for (const o of objects.keys()) {
      for (const link of this.links(o)) {
        if (!this.objects.has(link)) throw new Error('Missing object: ' + link)
      }
    }

    let cur = oid
    if (!this.objects.has(cur)) throw new Error('Missing object: ' + cur)
    while (this.meta.get(cur).type === 'tag') cur = this.meta.get(cur).object

    const tag = ref.startsWith('tags/')
    if (!tag && this.meta.get(cur).type !== 'commit') throw new Error('Expected commit: ' + cur)

    if (tag) {
      this.tags.set(ref.slice(5), oid)
      return
    }

    this.branches.set(ref, oid)
    if (this.head === null || (this.head === this.auto && rank(ref) < rank(this.head))) {
      this.head = this.auto = ref
    }
  }

  // What a writer needs to carry on from this state in another process
  toJSON() {
    return {
      objects: [...this.objects.keys()],
      branches: [...this.branches],
      tags: [...this.tags],
      head: this.head
    }
  }

  static from(meta, objects, json) {
    const model = new Model(meta)
    for (const oid of json.objects) model.objects.set(oid, objects.get(oid))
    model.branches = new Map(json.branches)
    model.tags = new Map(json.tags)
    model.head = json.head
    return model
  }

  reopen() {
    this.auto = null
  }

  deleteBranch(name) {
    return this.branches.delete(name)
  }

  deleteTag(name) {
    return this.tags.delete(name)
  }

  setHead(name) {
    this.head = name
    this.auto = null
  }

  refs() {
    const refs = []
    for (const [name, oid] of this.branches) refs.push({ ref: `refs/heads/${name}`, oid })
    for (const [name, oid] of this.tags) {
      const ref = { ref: `refs/tags/${name}`, oid }
      let peeled = oid
      while (this.meta.get(peeled).type === 'tag') peeled = this.meta.get(peeled).object
      if (peeled !== oid) ref.peeled = peeled
      refs.push(ref)
    }
    if (this.head !== null && this.branches.has(this.head)) {
      refs.push({
        ref: 'HEAD',
        symref: `refs/heads/${this.head}`,
        oid: this.branches.get(this.head)
      })
    }
    return refs
  }

  tips() {
    return new Set([...this.branches.values(), ...this.tags.values()])
  }

  // Every stored object reachable from `oid`, skipping what `seen` holds.
  // Like the Remote, `seen` also collects referenced oids that aren't stored
  // (but not submodule commits, which are never followed).
  closure(oid, seen = new Set()) {
    const out = []
    const stack = [oid]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      if (!this.objects.has(cur)) continue
      out.push(cur)

      stack.push(...this.links(cur))
    }
    return out
  }

  getRefObjects(oid, seen) {
    return this.tips().has(oid) ? this.closure(oid, seen) : []
  }

  // The drive view of a ref: Map<path, { oid, mode }>, null when no such ref
  // or when it is a tag of something other than a commit. `name` is a full
  // ref name, or a bare one: a branch shadows a tag of the same name.
  files(name) {
    let oid
    if (name.startsWith('refs/heads/')) oid = this.branches.get(name.slice(11))
    else if (name.startsWith('refs/tags/')) oid = this.tags.get(name.slice(10))
    else {
      oid = this.branches.get(name) ?? this.tags.get(name)
      if (oid === undefined && name.startsWith('tags/')) oid = this.tags.get(name.slice(5))
    }
    if (oid === undefined) return null
    while (this.meta.get(oid).type === 'tag') oid = this.meta.get(oid).object
    if (this.meta.get(oid).type !== 'commit') return null

    const files = new Map()
    const walk = (treeOid, prefix) => {
      if (!this.objects.has(treeOid)) return
      for (const e of this.meta.get(treeOid).entries) {
        const path = prefix + '/' + e.name
        if (e.mode === '40000') walk(e.oid, path)
        else files.set(path, { oid: e.oid, mode: e.mode })
      }
    }
    walk(this.meta.get(oid).tree, '')
    return files
  }
}

function rank(branch) {
  return branch === 'main' ? 0 : branch === 'master' ? 1 : 2
}
