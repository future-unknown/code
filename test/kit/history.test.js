import should from 'should'
import { withTree, human, agent } from './helpers.js'
import { NotFoundError, ValidationError, RevisionConflictError } from '../../lib/kit/index.js'

describe('history', () => {
  it('lists a file\'s revisions, newest first, through a move', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: '1', actor: human, message: 'first' })
    await kit.writeFile({ treeId, path: 'a.js', content: '2', actor: agent, message: 'second' })
    await kit.moveFile({ treeId, from: 'a.js', to: 'b.js', actor: human })
    await kit.writeFile({ treeId, path: 'b.js', content: '3', actor: human })
    const history = await kit.fileHistory({ treeId, path: 'b.js' })
    history.map((entry) => [entry.path, entry.action]).should.eql([
      ['b.js', 'updated'], ['b.js', 'moved'], ['a.js', 'updated'], ['a.js', 'created']
    ])
    history[2].change.should.match({ message: 'second', actor: { type: 'agent', onBehalfOf: 'user_test' } })
    ;(await kit.fileHistory({ treeId, path: 'b.js', limit: 2 })).should.have.length(2)
  })

  it('keeps a removed file\'s history, and a file written again starts over as created', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: '1', actor: human })
    await kit.removeFile({ treeId, path: 'a.js', actor: human })
    await kit.writeFile({ treeId, path: 'a.js', content: '2', actor: human })
    ;(await kit.fileHistory({ treeId, path: 'a.js' })).map((entry) => entry.action).should.eql(['created', 'deleted', 'created'])
  })

  it('refuses history of the root or a folder, and of a path never written', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'src/a.js', content: '1', actor: human })
    await kit.fileHistory({ treeId, path: '' }).should.be.rejectedWith(ValidationError, { message: /code.changes/ })
    await kit.fileHistory({ treeId, path: 'src' }).should.be.rejectedWith(ValidationError, { message: /folder/ })
    await kit.fileHistory({ treeId, path: 'nope.js' }).should.be.rejectedWith(NotFoundError)
  })

  it('reads a revision and the one before it', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: 'one', actor: human })
    const { revisionId } = await kit.writeFile({ treeId, path: 'a.js', content: 'two', actor: human })
    const revision = await kit.getRevision({ treeId, revisionId })
    revision.content.should.equal('two')
    revision.previous.content.should.equal('one')
  })

  it('lists changes under a path, and pages them with before', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'src/a.js', content: '1', actor: human })
    await kit.writeFile({ treeId, path: 'b.js', content: '1', actor: human })
    const third = await kit.writeFile({ treeId, path: 'src/c.js', content: '1', actor: human })
    ;(await kit.getChanges({ treeId, path: 'src' })).flatMap((change) => change.files.map((file) => file.path)).should.eql(['src/c.js', 'src/a.js'])
    ;(await kit.getChanges({ treeId, before: third.changeId })).should.have.length(2)
  })

  it('gives a change with a patch for each text file', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: 'const a = 1\n', actor: human })
    const { changeId } = await kit.editFile({ treeId, path: 'a.js', oldString: '1', newString: '2', actor: human, message: 'bump' })
    const change = await kit.getChange({ treeId, changeId })
    change.message.should.equal('bump')
    change.files[0].patch.should.containEql('-const a = 1').and.containEql('+const a = 2')
  })

  describe('restore', () => {
    it('puts the whole tree back as it stood, as a new change', async () => {
      const { kit, treeId } = await withTree()
      const first = await kit.writeFile({ treeId, path: 'a.js', content: '1', actor: human })
      await kit.writeFile({ treeId, path: 'a.js', content: '2', actor: human })
      await kit.writeFile({ treeId, path: 'b.js', content: 'b', actor: human })
      const result = await kit.restore({ treeId, changeId: first.changeId, actor: human })
      result.should.match({ changed: true, restored: ['a.js'], removed: ['b.js'] })
      ;(await kit.readFile({ treeId, path: 'a.js' })).content.should.equal('1')
      const [change] = await kit.getChanges({ treeId })
      change.message.should.equal(`restore the tree to change ${first.changeId}`)
    })

    it('restores one file, leaving the rest', async () => {
      const { kit, treeId } = await withTree()
      const first = await kit.writeFile({ treeId, path: 'a.js', content: '1', actor: human })
      await kit.writeFile({ treeId, path: 'a.js', content: '2', actor: human })
      await kit.writeFile({ treeId, path: 'b.js', content: 'b', actor: human })
      ;(await kit.restore({ treeId, path: 'a.js', changeId: first.changeId, actor: human })).restored.should.eql(['a.js'])
      ;(await kit.readFile({ treeId, path: 'b.js' })).content.should.equal('b')
    })

    it('brings back a removed file', async () => {
      const { kit, treeId } = await withTree()
      const { changeId } = await kit.writeFile({ treeId, path: 'a.js', content: '1', actor: human })
      await kit.removeFile({ treeId, path: 'a.js', actor: human })
      await kit.restore({ treeId, path: 'a.js', changeId, actor: human })
      ;(await kit.readFile({ treeId, path: 'a.js' })).content.should.equal('1')
    })

    it('makes no change when nothing differs, and honours ifChange', async () => {
      const { kit, treeId } = await withTree()
      const { changeId } = await kit.writeFile({ treeId, path: 'a.js', content: '1', actor: human })
      const same = await kit.restore({ treeId, changeId, actor: human })
      same.changed.should.be.false()
      await kit.writeFile({ treeId, path: 'a.js', content: '2', actor: human })
      await kit.restore({ treeId, changeId, ifChange: changeId, actor: human }).should.be.rejectedWith(RevisionConflictError)
    })
  })
})
