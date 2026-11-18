// zlib sizes its state for a 32 KiB window and 16 KiB of output whatever it
// is given, and on Bare that state is allocated per call: hundreds of KiB of
// garbage for an object of a few bytes, which is what the resident memory of
// a large push or clone then consists of. A window that covers the payload
// compresses and inflates the same.
module.exports = function zlibOptions(size) {
  const windowBits = Math.min(15, Math.max(9, Math.ceil(Math.log2(size + 1))))
  return {
    windowBits,
    memLevel: Math.max(1, windowBits - 7),
    chunkSize: Math.min(65536, Math.max(64, size))
  }
}
