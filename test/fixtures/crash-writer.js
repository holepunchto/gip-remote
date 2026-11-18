// Applies a generated script of mutations to the Remote in `dir`, from op
// `start` on and from the model state in `state`, logging each op's start
// and completion synchronously so the parent knows how far it got when it
// kills this process.
const { appendFileSync, readFileSync } = require('fs')
const Model = require('../helpers/model')
const { generate, apply, Sut } = require('../helpers/fuzz')

const [dir, log, seed, length, start, state] = Bare.argv.slice(2)

main()

async function main() {
  const { universe, script } = generate(Number(seed), {
    length: Number(length),
    mutationsOnly: true
  })
  const model = Model.from(universe.meta, universe.objects, JSON.parse(readFileSync(state)))

  const sut = new Sut(dir)
  await sut.open()

  for (let i = Number(start); i < script.length; i++) {
    appendFileSync(log, `start ${i}\n`)
    console.log(i)
    await apply(sut.remote, model, universe, script[i])
    appendFileSync(log, `done ${i}\n`)
  }

  await sut.close()
}
