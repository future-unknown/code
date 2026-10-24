import should from 'should'
import { withTree, human } from './helpers.js'
import { analyze } from '../../lib/kit/index.js'

function messages (problems) {
  return problems.map((problem) => `${problem.path}:${problem.line} ${problem.message}`)
}

describe('checks', () => {
  it('reports a syntax error where it is', () => {
    const { problems } = analyze('a.js', 'const a = 1\nconst = 2\n')
    problems.should.match([{ line: 2, column: 7 }])
  })

  it('parses JSX and TypeScript, and finds their imports', () => {
    analyze('a.jsx', 'import x from "./x.js"\nexport default () => <div>{x}</div>\n').refs.should.match([{ specifier: './x.js', line: 1 }])
    analyze('a.ts', 'import type { T } from "./t.js"\nimport { v } from "./v.js"\nexport const n: number = v\n').refs.map((ref) => ref.specifier).should.eql(['./v.js'])
    analyze('a.tsx', 'const a = <b>\n').problems.should.not.be.empty()
  })

  it('returns the tree\'s problems with every write', async () => {
    const { kit, treeId } = await withTree()
    const { problems } = await kit.writeFile({ treeId, path: 'index.html', content: '<link rel="stylesheet" href="style.css">\n<script type="module" src="app.js"></script>\n', actor: human })
    messages(problems).should.eql([
      'index.html:1 style.css is not a file in this tree',
      'index.html:2 app.js is not a file in this tree'
    ])
    await kit.writeFile({ treeId, path: 'style.css', content: 'body { background: url(bg.png) }\n', actor: human })
    const after = await kit.writeFile({ treeId, path: 'app.js', content: 'import "./missing"\n', actor: human })
    messages(after.problems).should.eql([
      'app.js:1 ./missing is not a file in this tree',
      'style.css:1 bg.png is not a file in this tree'
    ])
  })

  it('says browsers add no extensions, and names a file mistaken for a package', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'util.js', content: 'export const u = 1\n', actor: human })
    const { problems } = await kit.writeFile({ treeId, path: 'app.js', content: 'import { u } from "./util"\nimport x from "util.js"\n', actor: human })
    messages(problems).should.eql([
      'app.js:1 ./util is not a file; browsers add no extensions, so write ./util.js',
      'app.js:2 util.js reads as a package name; write ./util.js for the file'
    ])
  })

  it('wants packages pinned, and refuses Node modules', async () => {
    const { kit, treeId } = await withTree()
    const { problems } = await kit.writeFile({ treeId, path: 'app.js', content: 'import { h } from "preact"\nimport hooks from "preact/hooks"\nimport fs from "node:fs"\n', actor: human })
    messages(problems).should.eql([
      'app.js:1 preact is not in the import map; pin preact with code.pin',
      'app.js:2 preact/hooks is not in the import map; pin preact with code.pin',
      'app.js:3 node:fs is a Node module; a site runs in the browser'
    ])
    const pinned = await kit.pin({ treeId, package: 'preact', actor: human })
    messages(pinned.problems).should.eql(['app.js:3 node:fs is a Node module; a site runs in the browser'])
  })

  it('checks inline module scripts, and refuses an inline import map', async () => {
    const { kit, treeId } = await withTree()
    const { problems } = await kit.writeFile({
      treeId,
      path: 'index.html',
      content: '<!doctype html>\n<script type="importmap">{}</script>\n<script type="module">\nimport x from "./x.js"\n</script>\n<a href="/elsewhere">ok</a>\n',
      actor: human
    })
    messages(problems).should.eql([
      'index.html:2 this tree\'s import map is imports.json, which publishing adds to each page; pin packages with code.pin instead of an inline map',
      'index.html:4 ./x.js is not a file in this tree'
    ])
  })

  it('leaves URLs alone and accepts a link to a folder with an index', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'docs/index.html', content: '<p>docs</p>\n', actor: human })
    const { problems } = await kit.writeFile({
      treeId,
      path: 'index.html',
      content: '<script src="https://cdn.example.com/x.js"></script>\n<iframe src="docs/"></iframe>\n<img src="data:image/png;base64,AA==">\n',
      actor: human
    })
    problems.should.eql([])
  })

  it('reports problems in imports.json itself', async () => {
    const { kit, treeId } = await withTree()
    const { problems } = await kit.writeFile({ treeId, path: 'imports.json', content: '{"imports": {"a": 1}}', actor: human })
    problems.should.match([{ path: 'imports.json', message: /something other than a URL/ }])
  })

  it('checks the tree as of a change', async () => {
    const { kit, treeId } = await withTree()
    const broken = await kit.writeFile({ treeId, path: 'a.js', content: 'const = 1', actor: human })
    await kit.writeFile({ treeId, path: 'a.js', content: 'const a = 1', actor: human })
    ;(await kit.check({ treeId })).problems.should.eql([])
    const then = await kit.check({ treeId, changeId: broken.changeId })
    then.should.match({ changeId: broken.changeId, files: 1 })
    then.problems.should.have.length(1)
  })
})
