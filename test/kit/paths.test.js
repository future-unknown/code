import should from 'should'
import { parseAddress, parseFilePath, assertTreeName, resolveReference, ValidationError } from '../../lib/kit/index.js'

describe('paths', () => {
  it('parses addresses into tree and path', () => {
    parseAddress('hello:src/app.js').should.eql({ tree: 'hello', path: 'src/app.js' })
    parseAddress('hello:').should.eql({ tree: 'hello', path: '' })
    parseAddress('hello').should.eql({ tree: 'hello', path: '' })
    parseAddress('hello:/src/').should.eql({ tree: 'hello', path: 'src' })
  })

  it('refuses bad tree names and path segments', () => {
    should.throws(() => parseAddress('Hello:x'), ValidationError)
    should.throws(() => parseFilePath('a/../b'), ValidationError)
    should.throws(() => parseFilePath('a//b'), ValidationError)
    should.throws(() => parseFilePath('a b.js'), ValidationError)
    should.throws(() => assertTreeName('-x'), ValidationError)
    parseFilePath('.well-known/x.json').should.equal('.well-known/x.json')
  })

  it('resolves references the way a browser does', () => {
    resolveReference('src/app.js', './util.js').should.equal('src/util.js')
    resolveReference('src/app.js', '../style.css').should.equal('style.css')
    resolveReference('src/app.js', '/index.html').should.equal('index.html')
    resolveReference('index.html', 'app.js').should.equal('app.js')
    should(resolveReference('index.html', '../x')).be.null()
  })
})
