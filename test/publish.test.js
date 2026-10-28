import should from 'should'
import { createHash } from 'node:crypto'
import { withTree, human } from './kit/helpers.js'
import { publishFiles, withHead, inlineImportMap } from '../lib/publish/index.js'

const sha = (text) => createHash('sha256').update(text).digest('hex')
const MAP = '<script type="importmap">{}</script>'

describe('publishing a tree', () => {
  it('lists every file with its size and hash, and reads contents only when asked', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'index.html', content: '<h1>hi</h1>\n', actor: human })
    await kit.writeFile({ treeId, path: 'css/app.css', content: 'body{}\n', actor: human })
    await kit.writeFile({ treeId, path: 'logo.png', base64: Buffer.from([0x89, 0, 1, 2]).toString('base64'), actor: human })
    const { changeId, entries } = await publishFiles(kit, { treeId })
    changeId.should.equal(3)
    entries.map((entry) => [entry.name, entry.size, entry.sha256]).should.eql([
      ['css/app.css', 7, sha('body{}\n')],
      ['index.html', 12, sha('<h1>hi</h1>\n')],
      ['logo.png', 4, sha(Buffer.from([0x89, 0, 1, 2]))]
    ])
    entries[1].content().toString().should.equal('<h1>hi</h1>\n')
    entries[2].content().equals(Buffer.from([0x89, 0, 1, 2])).should.be.true()
  })

  it('publishes the tree as it stood after a change', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'index.html', content: 'one\n', actor: human })
    await kit.writeFile({ treeId, path: 'index.html', content: 'two\n', actor: human })
    await kit.writeFile({ treeId, path: 'later.js', content: 'x\n', actor: human })
    const { changeId, entries } = await publishFiles(kit, { treeId, changeId: 1 })
    changeId.should.equal(1)
    entries.map((entry) => entry.name).should.eql(['index.html'])
    entries[0].content().toString().should.equal('one\n')
  })

  it('adds the import map to every page, and the page goes under its new hash', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'index.html', content: '<!doctype html>\n<html><head><title>Hi</title></head><body><script type="module" src="./app.js"></script></body></html>\n', actor: human })
    await kit.writeFile({ treeId, path: 'about/index.htm', content: '<p>about</p>\n', actor: human })
    await kit.writeFile({ treeId, path: 'app.js', content: "import { h } from 'preact'\n", actor: human })
    await kit.pin({ treeId, package: 'preact', actor: human })
    const { entries } = await publishFiles(kit, { treeId })
    const page = entries.find((entry) => entry.name === 'index.html')
    const html = page.content().toString()
    html.should.startWith('<!doctype html>\n<html><head>\n<script type="importmap">\n')
    html.indexOf('importmap').should.be.below(html.indexOf('<title>'))
    JSON.parse(html.split('<script type="importmap">')[1].split('</script>')[0]).should.eql({
      imports: { preact: 'https://esm.sh/preact@1.2.3', 'preact/': 'https://esm.sh/preact@1.2.3/' }
    })
    page.size.should.equal(Buffer.byteLength(html))
    page.sha256.should.equal(sha(html))
    entries.find((entry) => entry.name === 'about/index.htm').content().toString().should.match(/^\n<script type="importmap">/)
    // scripts and the map itself go as they are
    entries.find((entry) => entry.name === 'app.js').content().toString().should.equal("import { h } from 'preact'\n")
    should.exist(entries.find((entry) => entry.name === 'imports.json'))
  })

  it('leaves pages alone when nothing is pinned or imports.json is unreadable', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'index.html', content: '<h1>hi</h1>\n', actor: human })
    ;(await publishFiles(kit, { treeId })).entries[0].content().toString().should.equal('<h1>hi</h1>\n')
    await kit.writeFile({ treeId, path: 'imports.json', content: 'nope', actor: human })
    ;(await publishFiles(kit, { treeId })).entries.find((entry) => entry.name === 'index.html').sha256.should.equal(sha('<h1>hi</h1>\n'))
  })

  it('puts the map inside head, else inside html, else before the first element', () => {
    withHead('<html lang="en"><head><meta charset="utf-8"></head></html>', { importMap: MAP }).should.equal(`<html lang="en"><head>\n${MAP}\n<meta charset="utf-8"></head></html>`)
    withHead('<!doctype html><html lang="en"><title>Hi</title></html>', { importMap: MAP }).should.equal(`<!doctype html><html lang="en">\n${MAP}\n<title>Hi</title></html>`)
    withHead('<!doctype html><title>Hi</title><h1>Hello</h1>', { importMap: MAP }).should.equal(`<!doctype html>\n${MAP}\n<title>Hi</title><h1>Hello</h1>`)
    withHead('<!doctype html>', { importMap: MAP }).should.equal(`<!doctype html>\n${MAP}\n`)
    withHead('', { importMap: MAP }).should.equal(`\n${MAP}\n`)
  })

  it("adds the host's head to every page, after the import map, and to a page with its own map", async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'index.html', content: '<head><title>Hi</title></head>\n', actor: human })
    await kit.writeFile({ treeId, path: 'app.js', content: 'x\n', actor: human })
    const head = '<script type="application/json" id="site">{"a":1}</script>'
    const { entries } = await publishFiles(kit, { treeId, head })
    entries.find((entry) => entry.name === 'index.html').content().toString().should.equal(`<head>\n${head}\n<title>Hi</title></head>\n`)
    entries.find((entry) => entry.name === 'app.js').content().toString().should.equal('x\n')
    await kit.pin({ treeId, package: 'preact', actor: human })
    const page = (await publishFiles(kit, { treeId, head })).entries.find((entry) => entry.name === 'index.html').content().toString()
    page.indexOf('importmap').should.be.below(page.indexOf('id="site"'))
    withHead('<head><script type="importmap">{}</script></head>', { importMap: MAP, head }).should.equal(`<head>\n${head}\n<script type="importmap">{}</script></head>`)
  })

  it("keeps a page's own import map and adds none", () => {
    const page = '<head><script type="importmap">{"imports":{}}</script></head>'
    withHead(page, { importMap: MAP }).should.equal(page)
  })

  it("escapes a closing tag inside the map's URLs", () => {
    inlineImportMap('{"imports":{"x":"https://e.sh/</script>"}}').should.not.match(/<\/script>.*<\/script>/s)
    should(inlineImportMap('{"imports":{}}')).be.null()
  })
})
