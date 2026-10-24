import should from 'should'
import { withTree, human } from './helpers.js'
import {
  NotFoundError, ValidationError, RevisionConflictError, AlreadyExistsError, InvalidMoveError
} from '../../lib/kit/index.js'

describe('move and remove', () => {
  it('moves a file in one change, listed once as a move', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: 'x', actor: human })
    const result = await kit.moveFile({ treeId, from: 'a.js', to: 'lib/b.js', actor: human })
    result.moved.should.eql([{ from: 'a.js', to: 'lib/b.js' }])
    await kit.readFile({ treeId, path: 'a.js' }).should.be.rejectedWith(NotFoundError)
    ;(await kit.readFile({ treeId, path: 'lib/b.js' })).content.should.equal('x')
    const [change] = await kit.getChanges({ treeId })
    change.files.should.match([{ path: 'lib/b.js', action: 'moved', from: 'a.js' }])
  })

  it('moves a folder and everything in it', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'src/a.js', content: 'a', actor: human })
    await kit.writeFile({ treeId, path: 'src/deep/b.js', content: 'b', actor: human })
    const result = await kit.moveFile({ treeId, from: 'src', to: 'lib', actor: human })
    result.moved.map((pair) => pair.to).should.eql(['lib/a.js', 'lib/deep/b.js'])
    ;(await kit.listFiles({ treeId })).children.map((child) => child.name).should.eql(['lib'])
  })

  it('refuses a move onto something, into itself, or with a stale revision', async () => {
    const { kit, treeId } = await withTree()
    const { revisionId } = await kit.writeFile({ treeId, path: 'a.js', content: 'a', actor: human })
    await kit.writeFile({ treeId, path: 'b.js', content: 'b', actor: human })
    await kit.writeFile({ treeId, path: 'src/c.js', content: 'c', actor: human })
    await kit.moveFile({ treeId, from: 'a.js', to: 'b.js', actor: human }).should.be.rejectedWith(AlreadyExistsError)
    await kit.moveFile({ treeId, from: 'src', to: 'src/inner', actor: human }).should.be.rejectedWith(InvalidMoveError)
    await kit.writeFile({ treeId, path: 'a.js', content: 'a2', actor: human })
    await kit.moveFile({ treeId, from: 'a.js', to: 'z.js', ifRevision: revisionId, actor: human }).should.be.rejectedWith(RevisionConflictError)
    await kit.moveFile({ treeId, from: 'nope', to: 'z', actor: human }).should.be.rejectedWith(NotFoundError)
  })

  it('removes a file, and a folder only when recursive', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: 'a', actor: human })
    await kit.writeFile({ treeId, path: 'src/b.js', content: 'b', actor: human })
    await kit.writeFile({ treeId, path: 'src/c.js', content: 'c', actor: human })
    ;(await kit.removeFile({ treeId, path: 'a.js', actor: human })).removed.should.eql(['a.js'])
    await kit.removeFile({ treeId, path: 'src', actor: human }).should.be.rejectedWith(ValidationError, { message: /folder with 2 files/ })
    ;(await kit.removeFile({ treeId, path: 'src', recursive: true, actor: human })).removed.should.eql(['src/b.js', 'src/c.js'])
    ;(await kit.listFiles({ treeId })).files.should.equal(0)
  })

  it('never removes the tree\'s root', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.js', content: 'a', actor: human })
    await kit.removeFile({ treeId, path: '', recursive: true, actor: human }).should.be.rejectedWith(ValidationError, { message: /not removed/ })
  })

  it('guards a removal with ifChange', async () => {
    const { kit, treeId } = await withTree()
    const { changeId } = await kit.writeFile({ treeId, path: 'a.js', content: 'a', actor: human })
    await kit.writeFile({ treeId, path: 'b.js', content: 'b', actor: human })
    await kit.removeFile({ treeId, path: 'a.js', ifChange: changeId, actor: human }).should.be.rejectedWith(RevisionConflictError)
    should((await kit.removeFile({ treeId, path: 'a.js', ifChange: changeId + 1, actor: human })).changeId).be.a.Number()
  })
})
