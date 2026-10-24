import should from 'should'
import { withTree, human } from './helpers.js'
import {
  NotFoundError, ValidationError, RevisionConflictError, EditMismatchError, PathConflictError, LimitError
} from '../../lib/kit/index.js'

describe('files', () => {
  it('writes and reads a file, each write one change', async () => {
    const { kit, treeId } = await withTree()
    const first = await kit.writeFile({ treeId, path: 'index.html', content: '<h1>Hi</h1>\n', actor: human, message: 'add page' })
    first.should.match({ path: 'index.html', changed: true, created: true, problems: [] })
    const file = await kit.readFile({ treeId, path: 'index.html' })
    file.should.match({ content: '<h1>Hi</h1>\n', binary: false, lines: 1, revisionId: first.revisionId, changeId: first.changeId })
    const second = await kit.writeFile({ treeId, path: 'index.html', content: '<h1>Hello</h1>\n', actor: human })
    second.changeId.should.be.above(first.changeId)
    second.created.should.be.false()
  })

  it('makes no change when the contents are the same', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.txt', content: 'x', actor: human })
    const again = await kit.writeFile({ treeId, path: 'a.txt', content: 'x', actor: human })
    again.changed.should.be.false()
    should(again.changeId).be.null()
  })

  it('reads a range of lines', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a.txt', content: 'one\ntwo\nthree\nfour\n', actor: human })
    const slice = await kit.readFile({ treeId, path: 'a.txt', offset: 2, limit: 2 })
    slice.should.match({ content: 'two\nthree\n', offset: 2, lines: 4 })
  })

  it('keeps binary files as bytes and reads them as base64', async () => {
    const { kit, treeId } = await withTree()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await kit.writeFile({ treeId, path: 'logo.png', base64: bytes.toString('base64'), actor: human })
    const file = await kit.readFile({ treeId, path: 'logo.png' })
    file.binary.should.be.true()
    Buffer.from(file.base64, 'base64').equals(bytes).should.be.true()
    await kit.editFile({ treeId, path: 'logo.png', oldString: 'P', newString: 'Q', actor: human })
      .should.be.rejectedWith(ValidationError, { message: /binary/ })
  })

  it('refuses content and base64 together, and neither', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'a', content: 'x', base64: 'eA==', actor: human }).should.be.rejectedWith(ValidationError)
    await kit.writeFile({ treeId, path: 'a', actor: human }).should.be.rejectedWith(ValidationError, { message: /content is required/ })
  })

  it('refuses a file larger than the limit', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1), actor: human })
      .should.be.rejectedWith(LimitError)
  })

  it('guards a write with ifRevision', async () => {
    const { kit, treeId } = await withTree()
    const { revisionId } = await kit.writeFile({ treeId, path: 'a.txt', content: 'one', actor: human })
    await kit.writeFile({ treeId, path: 'a.txt', content: 'two', actor: human })
    await kit.writeFile({ treeId, path: 'a.txt', content: 'three', ifRevision: revisionId, actor: human })
      .should.be.rejectedWith(RevisionConflictError)
  })

  it('says when a path is a folder, or missing', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'src/app.js', content: '', actor: human })
    await kit.readFile({ treeId, path: 'src' }).should.be.rejectedWith(ValidationError, { message: /folder; list it with code.tree/ })
    await kit.readFile({ treeId, path: 'nope.js' }).should.be.rejectedWith(NotFoundError)
    await kit.writeFile({ treeId, path: 'src', content: '', actor: human }).should.be.rejectedWith(PathConflictError)
    await kit.writeFile({ treeId, path: 'src/app.js/x', content: '', actor: human }).should.be.rejectedWith(PathConflictError)
  })

  it('reads a file as it was at a change', async () => {
    const { kit, treeId } = await withTree()
    const first = await kit.writeFile({ treeId, path: 'a.txt', content: 'one', actor: human })
    await kit.writeFile({ treeId, path: 'a.txt', content: 'two', actor: human })
    ;(await kit.readFile({ treeId, path: 'a.txt', changeId: first.changeId })).content.should.equal('one')
    await kit.readFile({ treeId, path: 'a.txt', changeId: 9999 }).should.be.rejectedWith(NotFoundError)
  })

  describe('edit', () => {
    it('replaces one exact string', async () => {
      const { kit, treeId } = await withTree()
      await kit.writeFile({ treeId, path: 'a.js', content: 'const a = 1\nconst b = 2\n', actor: human })
      const result = await kit.editFile({ treeId, path: 'a.js', oldString: 'b = 2', newString: 'b = 3', actor: human })
      result.replaced.should.equal(1)
      ;(await kit.readFile({ treeId, path: 'a.js' })).content.should.equal('const a = 1\nconst b = 3\n')
    })

    it('takes newString literally, $ patterns and all', async () => {
      const { kit, treeId } = await withTree()
      await kit.writeFile({ treeId, path: 'a.js', content: 'x', actor: human })
      await kit.editFile({ treeId, path: 'a.js', oldString: 'x', newString: '$&$1$$', actor: human })
      ;(await kit.readFile({ treeId, path: 'a.js' })).content.should.equal('$&$1$$')
    })

    it('refuses a string that is missing or occurs more than once', async () => {
      const { kit, treeId } = await withTree()
      await kit.writeFile({ treeId, path: 'a.js', content: 'x x x', actor: human })
      await kit.editFile({ treeId, path: 'a.js', oldString: 'y', newString: 'z', actor: human })
        .should.be.rejectedWith(EditMismatchError, { details: { occurrences: 0 } })
      await kit.editFile({ treeId, path: 'a.js', oldString: 'x', newString: 'z', actor: human })
        .should.be.rejectedWith(EditMismatchError, { message: /occurs 3 times/ })
      const all = await kit.editFile({ treeId, path: 'a.js', oldString: 'x', newString: 'z', replaceAll: true, actor: human })
      all.replaced.should.equal(3)
      ;(await kit.readFile({ treeId, path: 'a.js' })).content.should.equal('z z z')
    })
  })

  describe('tree', () => {
    it('lists folders first, with file counts, to a depth', async () => {
      const { kit, treeId } = await withTree()
      for (const path of ['index.html', 'src/app.js', 'src/lib/util.js', 'a.css']) {
        await kit.writeFile({ treeId, path, content: '', actor: human })
      }
      const root = await kit.listFiles({ treeId })
      root.files.should.equal(4)
      root.children.map((child) => child.name).should.eql(['src', 'a.css', 'index.html'])
      root.children[0].children.map((child) => child.name).should.eql(['lib', 'app.js'])
      const shallow = await kit.listFiles({ treeId, depth: 1 })
      should(shallow.children[0].children).be.undefined()
      shallow.children[0].files.should.equal(2)
      const src = await kit.listFiles({ treeId, path: 'src' })
      src.children.map((child) => child.path).should.eql(['src/lib', 'src/app.js'])
      await kit.listFiles({ treeId, path: 'index.html' }).should.be.rejectedWith(ValidationError, { message: /is a file/ })
      await kit.listFiles({ treeId, path: 'nope' }).should.be.rejectedWith(NotFoundError)
    })
  })
})
