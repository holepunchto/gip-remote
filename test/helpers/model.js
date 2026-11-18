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
  }

  clone() {
    const model = new Model(this.meta)
    model.objects = new Map(this.objects)
    model.branches = new Map(this.branches)
    model.tags = new Map(this.tags)
    model.head = this.head
    return model
  }

  push(ref, oid, objects) {
    const has = (o) => objects.has(o) || this.objects.has(o)

    let cur = oid
    if (!has(cur)) throw new Error('Object not found: ' + cur)
    while (this.meta.get(cur).type === 'tag') {
      cur = this.meta.get(cur).object
      if (!has(cur)) throw new Error('Object not found: ' + cur)
    }
    if (this.meta.get(cur).type !== 'commit') throw new Error('Expected commit: ' + cur)

    for (const [o, obj] of objects) {
      if (!this.objects.has(o)) this.objects.set(o, obj)
    }

    if (ref.startsWith('tags/')) {
      this.tags.set(ref.slice(5), oid)
      return
    }

    this.branches.set(ref, oid)
    if (this.head === null) this.head = ref
  }

  deleteBranch(name) {
    return this.branches.delete(name)
  }

  deleteTag(name) {
    return this.tags.delete(name)
  }

  setHead(name) {
    this.head = name
  }

  refs() {
    const refs = []
    for (const [name, oid] of this.branches) refs.push({ ref: `refs/heads/${name}`, oid })
    for (const [name, oid] of this.tags) refs.push({ ref: `refs/tags/${name}`, oid })
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
  // Like the Remote, `seen` also collects referenced oids that aren't stored.
  closure(oid, seen = new Set()) {
    const out = []
    const stack = [oid]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (seen.has(cur)) continue
      seen.add(cur)
      if (!this.objects.has(cur)) continue
      out.push(cur)

      const m = this.meta.get(cur)
      if (m.type === 'tag') stack.push(m.object)
      else if (m.type === 'commit') stack.push(m.tree, ...m.parents)
      else if (m.type === 'tree') for (const e of m.entries) stack.push(e.oid)
    }
    return out
  }

  getRefObjects(oid, seen) {
    return this.tips().has(oid) ? this.closure(oid, seen) : []
  }

  // The drive view of a ref: Map<path, { oid, mode }>, null when no such ref.
  // A branch shadows a tag of the same name.
  files(name) {
    let oid = this.branches.get(name) ?? this.tags.get(name)
    if (oid === undefined) return null
    while (this.meta.get(oid).type === 'tag') oid = this.meta.get(oid).object

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
