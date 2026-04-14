const git = require('rebuild-git')
const { GitTree } = git
const { dirname } = require('path')
const { promises: defaultFs } = require('fs')

// --- Git commit parser ---

function parseCommit(data) {
  const text = data.toString('utf8')
  const lines = text.split('\n')
  const result = { tree: null, parents: [], author: null, timestamp: 0, message: '' }

  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') {
      i++
      break
    }

    if (line.startsWith('tree ')) {
      result.tree = line.slice(5)
    } else if (line.startsWith('parent ')) {
      result.parents.push(line.slice(7))
    } else if (line.startsWith('author ')) {
      const match = line.match(/^author (.+) <.+> (\d+) [+-]\d+$/)
      if (match) {
        result.author = match[1]
        result.timestamp = parseInt(match[2])
      }
    }
  }

  result.message = lines.slice(i).join('\n').trim()
  return result
}

// --- Git tag parser ---

function parseTag(data) {
  const text = data.toString('utf8')
  const lines = text.split('\n')
  const result = { object: null, type: null, tag: null, tagger: null, timestamp: 0, message: '' }

  let i = 0
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line === '') {
      i++
      break
    }

    if (line.startsWith('object ')) result.object = line.slice(7)
    else if (line.startsWith('type ')) result.type = line.slice(5)
    else if (line.startsWith('tag ')) result.tag = line.slice(4)
    else if (line.startsWith('tagger ')) {
      const match = line.match(/^tagger (.+) <.+> (\d+) [+-]\d+$/)
      if (match) {
        result.tagger = match[1]
        result.timestamp = parseInt(match[2])
      }
    }
  }

  result.message = lines.slice(i).join('\n').trim()
  return result
}

// --- Tree walker: extracts all file paths from git tree objects ---

function walkTree(objects, treeOid, prefix) {
  const treeObj = objects.get(treeOid)
  if (!treeObj || treeObj.type !== 'tree') return []

  const entries = GitTree.from(treeObj.data).entries()
  const files = []

  for (const entry of entries) {
    const path = prefix + '/' + entry.path
    if (entry.type === 'tree') {
      files.push(...walkTree(objects, entry.oid, path))
    } else {
      const blob = objects.get(entry.oid)
      files.push({
        path,
        oid: entry.oid,
        mode: entry.mode || '100644',
        size: blob ? blob.size : 0
      })
    }
  }

  return files
}

/**
 * Write git objects to disk, rebuilding a Git repo from in-memory objects.
 *
 * @param {object} opts
 * @param {string} opts.gitDir - Path to the .git directory
 * @param {string} [opts.objectFormat='sha1'] - Hash algorithm
 * @param {Array} opts.objects - Array of { type, id, size, data }
 * @param {boolean} [opts.verifySizes=true] - Verify object sizes match
 */
async function toDisk(opts) {
  const {
    gitDir,
    objectFormat = 'sha1',
    objects,
    refs,
    head,
    fs = defaultFs,
    verifySizes = true
  } = opts

  if (!gitDir) throw new Error('gitDir is required')

  if (objectFormat !== 'sha1') {
    throw new Error('Only sha1 is supported')
  }

  if (!objects?.length) throw new Error('No objects supplied.')

  for (const o of objects) {
    if (!o.type || !o.id || o.data == null) {
      throw new Error('Invalid object entry: missing type/id/data')
    }
    const data = o.data || Buffer.alloc(0)
    if (verifySizes && data.length !== o.size) {
      throw new Error(
        `Size mismatch for ${o.type} ${o.id}: declared ${o.size}, buffer ${o.data.length}`
      )
    }

    const oid = await git.writeObject({
      fs,
      dir: dirname(gitDir),
      type: o.type,
      object: data
    })

    if (oid !== o.id) {
      throw new Error(`OID mismatch for ${o.type}: expected ${o.id} but git computed ${oid}`)
    }
  }

  if (refs) {
    for (const [refName, oid] of Object.entries(refs)) {
      await git.writeRef({
        fs,
        dir: dirname(gitDir),
        ref: refName,
        value: oid,
        force: true
      })
    }
  }

  if (head) {
    await git.writeRef({
      fs,
      dir: dirname(gitDir),
      ref: 'HEAD',
      value: `ref: refs/heads/${head}`,
      force: true
    })
  }
}

module.exports = { parseCommit, parseTag, walkTree, toDisk }
