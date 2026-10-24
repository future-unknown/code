import should from 'should'
import { createTestKit, human } from './helpers.js'
import { AlreadyExistsError, ValidationError, STARTERS } from '../../lib/kit/index.js'

describe('trees', () => {
  it('creates an empty tree with no change', async () => {
    const { kit } = await createTestKit()
    const { tree, changeId, problems } = await kit.createTree({ name: 'hello', description: 'A page', actor: human })
    tree.should.match({ name: 'hello', description: 'A page', title: null, files: 0, changeId: null })
    should(changeId).be.null()
    problems.should.eql([])
  })

  it('starts from a starter as one change, with no problems', async () => {
    const { kit } = await createTestKit()
    const { tree, changeId, problems } = await kit.createTree({ name: 'hello', starter: 'html', actor: human })
    changeId.should.be.a.Number()
    tree.files.should.equal(Object.keys(STARTERS.html.files).length)
    problems.should.eql([])
    const [change] = await kit.getChanges({ treeId: tree.id })
    change.message.should.equal('start from the html starter')
    change.files.map((file) => file.action).should.eql(['created', 'created', 'created'])
  })

  it('refuses a taken name, a bad name, and an unknown starter', async () => {
    const { kit } = await createTestKit()
    await kit.createTree({ name: 'hello', actor: human })
    await kit.createTree({ name: 'hello', actor: human }).should.be.rejectedWith(AlreadyExistsError)
    await kit.createTree({ name: 'Hello', actor: human }).should.be.rejectedWith(ValidationError)
    await kit.createTree({ name: 'other', starter: 'next', actor: human }).should.be.rejectedWith(ValidationError, { message: /starters are html/ })
  })

  it('lists, finds and updates trees', async () => {
    const { kit } = await createTestKit()
    await kit.createTree({ name: 'zeta', actor: human })
    const { tree } = await kit.createTree({ name: 'alpha', actor: human })
    ;(await kit.listTrees()).map((each) => each.name).should.eql(['alpha', 'zeta'])
    ;(await kit.findTree({ name: 'alpha' })).id.should.equal(tree.id)
    should(await kit.findTree({ name: 'none' })).be.null()
    const updated = await kit.updateTree({ treeId: tree.id, title: 'Alpha', description: 'first' })
    updated.should.match({ title: 'Alpha', description: 'first' })
    ;(await kit.updateTree({ treeId: tree.id, description: null })).should.match({ title: 'Alpha', description: null })
    await kit.updateTree({ treeId: tree.id }).should.be.rejectedWith(ValidationError)
  })

  it('keeps its tables apart from anything else in the database', async () => {
    const { db } = await createTestKit()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name)
    tables.every((name) => name.startsWith('code_')).should.be.true()
    tables.should.containEql('code_migrations')
  })
})
