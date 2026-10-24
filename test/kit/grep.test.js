import should from 'should'
import { withTree, human } from './helpers.js'
import { ValidationError, NotFoundError } from '../../lib/kit/index.js'

describe('grep', () => {
  async function seeded () {
    const setup = await withTree()
    const { kit, treeId } = setup
    await kit.writeFile({ treeId, path: 'index.html', content: '<script src="app.js"></script>\n', actor: human })
    await kit.writeFile({ treeId, path: 'app.js', content: 'const rows = []\nfunction load () {\n  return Rows\n}\n', actor: human })
    await kit.writeFile({ treeId, path: 'lib/util.js', content: 'export const rows = 1\n', actor: human })
    await kit.writeFile({ treeId, path: 'logo.png', base64: Buffer.from([0, 1, 2]).toString('base64'), actor: human })
    return setup
  }

  it('finds literal matches as path and line', async () => {
    const { kit, treeId } = await seeded()
    const { matches, truncated, files } = await kit.grep({ treeId, pattern: 'rows' })
    matches.map((match) => `${match.path}:${match.line}`).should.eql(['app.js:1', 'lib/util.js:1'])
    truncated.should.be.false()
    files.should.equal(3)
  })

  it('matches regardless of case, or by regex, under a path', async () => {
    const { kit, treeId } = await seeded()
    ;(await kit.grep({ treeId, pattern: 'rows', ignoreCase: true })).matches.should.have.length(3)
    ;(await kit.grep({ treeId, pattern: '^export', regex: true })).matches.map((match) => match.path).should.eql(['lib/util.js'])
    ;(await kit.grep({ treeId, pattern: 'rows', path: 'lib' })).matches.should.have.length(1)
  })

  it('gives lines of context and stops at the limit', async () => {
    const { kit, treeId } = await seeded()
    const [match] = (await kit.grep({ treeId, pattern: 'function', context: 1 })).matches
    match.before.should.eql(['const rows = []'])
    match.after.should.eql(['  return Rows'])
    const limited = await kit.grep({ treeId, pattern: 'r', limit: 2 })
    limited.matches.should.have.length(2)
    limited.truncated.should.be.true()
  })

  it('refuses a bad regex and an empty pattern', async () => {
    const { kit, treeId } = await seeded()
    await kit.grep({ treeId, pattern: '(', regex: true }).should.be.rejectedWith(ValidationError, { message: /not a valid regex/ })
    await kit.grep({ treeId, pattern: '' }).should.be.rejectedWith(ValidationError)
    await kit.grep({ treeId, pattern: 'x', path: 'nope' }).should.be.rejectedWith(NotFoundError)
  })
})
