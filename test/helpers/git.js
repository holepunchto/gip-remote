const crypto = require('bare-crypto')
const b4a = require('b4a')

const IDENT = 'Test User <test@test.com>'

function object(type, data) {
  const header = b4a.from(`${type} ${data.byteLength}\0`)
  const oid = crypto.createHash('sha1').update(header).update(data).digest('hex')
  return { oid, type, size: data.byteLength, data }
}

function blob(data) {
  return object('blob', typeof data === 'string' ? b4a.from(data) : data)
}

// entries: [{ mode, name, oid }], mode '40000' for a sub-tree
function tree(entries) {
  const sorted = entries
    .map((e) => ({ ...e, key: b4a.from(e.mode === '40000' ? e.name + '/' : e.name) }))
    .sort((a, b) => b4a.compare(a.key, b.key))

  const parts = []
  for (const e of sorted) {
    parts.push(b4a.from(`${e.mode} ${e.name}\0`), b4a.from(e.oid, 'hex'))
  }
  return object('tree', b4a.concat(parts))
}

function commit({ tree, parents = [], time = 1700000000, message = 'commit' }) {
  const lines = [`tree ${tree}`]
  for (const parent of parents) lines.push(`parent ${parent}`)
  lines.push(`author ${IDENT} ${time} +0000`, `committer ${IDENT} ${time} +0000`, '', message, '')
  return object('commit', b4a.from(lines.join('\n')))
}

function tag({ object: target, type = 'commit', name, time = 1700000000, message = 'tag' }) {
  const lines = [
    `object ${target}`,
    `type ${type}`,
    `tag ${name}`,
    `tagger ${IDENT} ${time} +0000`,
    '',
    message,
    ''
  ]
  return object('tag', b4a.from(lines.join('\n')))
}

// Map<oid, { type, size, data }> as push() takes it
function toObjects(list) {
  const objects = new Map()
  for (const { oid, type, size, data } of list) objects.set(oid, { type, size, data })
  return objects
}

module.exports = { blob, tree, commit, tag, toObjects }
