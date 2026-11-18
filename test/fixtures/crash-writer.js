// Applies a generated script of mutations to the Remote in `dir`, from op
// `start` on, logging each op's start and completion synchronously so the
// parent knows how far it got when it kills this process.
const { appendFileSync } = require('fs')
const Model = require('../helpers/model')
const { generate, expect, apply, Sut } = require('../helpers/fuzz')

const [dir, log, seed, length, start] = Bare.argv.slice(2)

main()

async function main() {
  const { universe, script } = generate(Number(seed), {
    length: Number(length),
    mutationsOnly: true
  })
  const model = new Model(universe.meta)
  for (let i = 0; i < Number(start); i++) expect(model, universe, script[i])
  model.reopen()

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
