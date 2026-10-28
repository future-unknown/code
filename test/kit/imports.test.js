import should from 'should'
import { withTree, human } from './helpers.js'
import { createRegistryResolver, lookupImport, parsePackageSpec, NotFoundError, ValidationError } from '../../lib/kit/index.js'

describe('the import map', () => {
  it('pins a package and its subpaths in imports.json', async () => {
    const { kit, treeId } = await withTree()
    const pinned = await kit.pin({ treeId, package: 'preact', actor: human })
    pinned.package.should.eql({ name: 'preact', version: '1.2.3', url: 'https://esm.sh/preact@1.2.3' })
    const file = await kit.readFile({ treeId, path: 'imports.json' })
    JSON.parse(file.content).should.eql({
      imports: { preact: 'https://esm.sh/preact@1.2.3', 'preact/': 'https://esm.sh/preact@1.2.3/' }
    })
    const [change] = await kit.getChanges({ treeId })
    change.message.should.equal('pin preact@1.2.3')
  })

  it('re-pins, lists and unpins', async () => {
    const { kit, treeId } = await withTree()
    await kit.pin({ treeId, package: '@preact/signals', actor: human })
    await kit.pin({ treeId, package: 'preact@10.0.0', actor: human })
    ;(await kit.deps({ treeId })).packages.should.eql([
      { name: '@preact/signals', version: '1.2.3', url: 'https://esm.sh/@preact/signals@1.2.3' },
      { name: 'preact', version: '10.0.0', url: 'https://esm.sh/preact@10.0.0' }
    ])
    await kit.unpin({ treeId, package: 'preact', actor: human })
    ;(await kit.deps({ treeId })).packages.map((each) => each.name).should.eql(['@preact/signals'])
    await kit.unpin({ treeId, package: 'preact', actor: human }).should.be.rejectedWith(NotFoundError)
    await kit.unpin({ treeId, package: 'preact@1', actor: human }).should.be.rejectedWith(ValidationError)
  })

  it('refuses to pin over an unreadable imports.json', async () => {
    const { kit, treeId } = await withTree()
    await kit.writeFile({ treeId, path: 'imports.json', content: 'nope', actor: human })
    await kit.pin({ treeId, package: 'preact', actor: human }).should.be.rejectedWith(ValidationError, { message: /fix imports.json first/ })
  })

  it('parses package specs', () => {
    parsePackageSpec('react').should.eql({ name: 'react', version: undefined })
    parsePackageSpec('react@^18').should.eql({ name: 'react', version: '^18' })
    parsePackageSpec('@scope/pkg@1.0.0').should.eql({ name: '@scope/pkg', version: '1.0.0' })
    parsePackageSpec('react', '18.3.1').version.should.equal('18.3.1')
    should.throws(() => parsePackageSpec('Not A Package'), ValidationError)
  })

  it('looks up bare specifiers the way browsers do', () => {
    const map = { imports: { react: 'https://esm.sh/react@18', 'react/': 'https://esm.sh/react@18/' } }
    lookupImport(map, 'react').should.equal('https://esm.sh/react@18')
    lookupImport(map, 'react/jsx-runtime').should.equal('https://esm.sh/react@18/jsx-runtime')
    should(lookupImport(map, 'preact')).be.null()
  })

  describe('the registry resolver', () => {
    const document = {
      'dist-tags': { latest: '18.3.1', next: '19.0.0-rc' },
      versions: { '17.0.2': {}, '18.2.0': {}, '18.3.1': {}, '19.0.0-rc': {} }
    }
    const fetch = async (url) => (url.endsWith('/react')
      ? { ok: true, status: 200, json: async () => document }
      : { ok: false, status: 404 })
    const resolve = createRegistryResolver({ fetch })

    it('resolves the latest, a tag, an exact version and a range', async () => {
      ;(await resolve('react')).should.eql({ name: 'react', version: '18.3.1', url: 'https://esm.sh/react@18.3.1' })
      ;(await resolve('react', 'next')).version.should.equal('19.0.0-rc')
      ;(await resolve('react', '17.0.2')).version.should.equal('17.0.2')
      ;(await resolve('react', '^18.0.0')).version.should.equal('18.3.1')
    })

    it('says when a package or version does not exist', async () => {
      await resolve('nope').should.be.rejectedWith(NotFoundError)
      await resolve('react', '^20').should.be.rejectedWith(NotFoundError)
    })
  })

  it('pins a package hosted on GitHub at the host\'s release, or an exact one', async () => {
    const resolve = createRegistryResolver({ fetch: () => { throw new Error('no registry') }, hosted: { wiki: { repo: 'future-unknown/wiki', version: '0.25.0' } } })
    ;(await resolve('wiki')).should.eql({ name: 'wiki', version: '0.25.0', url: 'https://esm.sh/gh/future-unknown/wiki@v0.25.0' })
    ;(await resolve('wiki', '0.24.0')).url.should.equal('https://esm.sh/gh/future-unknown/wiki@v0.24.0')
    await resolve('wiki', '^0.25').should.be.rejectedWith(ValidationError, { message: /exact version/ })

    const { kit, treeId } = await withTree({ resolvePackage: resolve })
    await kit.pin({ treeId, package: 'wiki', actor: human })
    ;(await kit.deps({ treeId })).packages.should.eql([{ name: 'wiki', version: '0.25.0', url: 'https://esm.sh/gh/future-unknown/wiki@v0.25.0' }])
    await kit.writeFile({ treeId, path: 'app.js', content: "import { createSessionStore } from 'wiki/session'\n", actor: human })
    ;(await kit.check({ treeId })).problems.should.eql([])
  })
})
