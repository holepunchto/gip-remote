// Pushes a repository of `count` files as a stream, clones it to disk as a
// stream, and prints the peak resident memory of this process.
const os = require('bare-os')
const Corestore = require('corestore')
const { spawnSync } = require('child_process')
const { join } = require('path')
const git = require('../helpers/git')
const { toDisk } = require('../../lib/git')
const { Remote } = require('../..')

const [dir, count] = Bare.argv.slice(2)

let peak = 0
const sample = () => (peak = Math.max(peak, os.memoryUsage().rss))
const timer = setInterval(sample, 20)

main()

async function main() {
  const store = new Corestore(join(dir, 'store'))
  const remote = new Remote(store, 'stream')

  const blob = (i) => git.blob(`file ${i} ` + 'x'.repeat(i % 400))
  const entries = []
  for (let i = 0; i < count; i++) {
    entries.push({ mode: '100644', name: `f${i}.txt`, oid: blob(i).oid })
  }
  const tree = git.tree(entries)
  const commit = git.commit({ tree: tree.oid })
  entries.length = 0

  async function* objects() {
    yield commit
    yield tree
    for (let i = 0; i < count; i++) {
      yield blob(i)
      sample()
    }
  }
  await remote.pushRef('refs/heads/main', commit.oid, objects())
  sample()

  const gitDir = join(dir, 'repo.git')
  spawnSync('git', ['init', '-q', '--bare', gitDir])
  await toDisk({
    gitDir,
    objects: remote.refObjects(commit.oid),
    refs: { 'refs/heads/main': commit.oid }
  })
  sample()

  clearInterval(timer)
  await remote.close()
  await store.close()

  const listed = spawnSync('git', ['--git-dir', gitDir, 'rev-list', '--count', '--objects', 'main'])
  console.log(JSON.stringify({ peak, objects: Number(listed.stdout.toString()) }))
}
