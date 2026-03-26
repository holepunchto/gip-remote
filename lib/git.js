const git = require('rebuild-git')
const { dirname } = require('path')
const { promises: fs } = require('fs')

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
  const { gitDir, objectFormat = 'sha1', objects, verifySizes = true } = opts

  if (!gitDir) throw new Error('gitDir is required')

  // TODO: Really?
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

    // Feed raw canonical bytes via stdin; Git will compute the id and store the object.
    // Note: repo's object-format governs the hash algorithm, so no extra flags needed.
    const oid = await git.writeObject({
      fs,
      dir: dirname(gitDir),
      type: o.type,
      object: data
    })

    if (oid !== o.id) {
      // If this fires, your payload/type/format doesn't match the supplied id.
      throw new Error(`OID mismatch for ${o.type}: expected ${o.id} but git computed ${oid}`)
    }
  }

  // TODO
  // 2) write refs (branches/tags) if provided
  // for (const [refName, oid] of Object.entries(refs)) {
  //   await git.writeRef({
  //     fs,
  //     dir: dirname(gitDir),
  //     ref: refName,
  //     value: oid,
  //     force: true
  //   })
  // }

  // Optionally set HEAD to a branch
  // if (head) {
  //   await git.writeRef({
  //     fs,
  //     dir: dirname(gitDir),
  //     ref: 'HEAD',
  //     value: `refs/heads/${head}`,
  //     force: true
  //   })
  // }
}

module.exports = { toDisk }
