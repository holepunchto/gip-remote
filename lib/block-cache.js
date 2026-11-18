// hyperbee2 reads the block a key lives in once per key and per tree node,
// and every key it then caches keeps its own copy of that block alive: about
// 4 KiB per key, 450 MiB for the keys of 100k objects. Handing out one shared
// buffer per block brings that down to the size of the blocks themselves.
//
// Blocks are immutable, so the cache only has to forget them when the core
// is truncated. `maxBytes` bounds what the cache itself keeps alive.
module.exports = function cacheBlocks(core, maxBytes) {
  const get = core.get.bind(core)
  const blocks = new Map()
  let bytes = 0

  core.on('truncate', () => {
    blocks.clear()
    bytes = 0
  })

  core.get = async function (seq, opts) {
    const cached = blocks.get(seq)
    if (cached) {
      // most recently used last
      blocks.delete(seq)
      blocks.set(seq, cached)
      return cached
    }

    const block = await get(seq, opts)
    if (block === null || blocks.has(seq)) return block

    blocks.set(seq, block)
    bytes += block.byteLength
    for (const [oldest, buffer] of blocks) {
      if (bytes <= maxBytes) break
      blocks.delete(oldest)
      bytes -= buffer.byteLength
    }
    return block
  }
}
