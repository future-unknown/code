import should from 'should'
import { once } from 'node:events'
import express from 'express'
import Database from 'better-sqlite3'
import { createCodeKit } from '../lib/kit/index.js'
import { createCodeRouter, createCodeMethods, createStaticTokenAuth, METHOD_DECLARATIONS } from '../lib/api/index.js'
import {
  CodeClient, ValidationError, NotFoundError, UnauthenticatedError, UnauthorizedError,
  EditMismatchError, RevisionConflictError, InvalidMoveError
} from '../lib/sdk/index.js'
import { fakeResolver } from './kit/helpers.js'

const servers = []

async function createTestApi () {
  const db = new Database(':memory:')
  const kit = createCodeKit({ db, resolvePackage: fakeResolver })
  await kit.migrate()
  const auth = createStaticTokenAuth({
    tokens: {
      'human-token': { actor: { type: 'human', id: 'user_123', onBehalfOf: null } },
      'agent-token': { actor: { type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' } },
      'read-token': { actor: { type: 'human', id: 'reader', onBehalfOf: null }, allow: ['code:read'] },
      'hello-token': { actor: { type: 'human', id: 'guest', onBehalfOf: null }, trees: ['hello'] }
    }
  })
  const app = express()
  app.use(createCodeRouter({ kit, auth }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { baseUrl, client: (token) => new CodeClient({ baseUrl, token }) }
}

after(() => {
  for (const server of servers) server.close()
})

describe('api', () => {
  let api
  let human
  let agent

  beforeEach(async () => {
    api = await createTestApi()
    human = api.client('human-token')
    agent = api.client('agent-token')
    await human.create('hello', { starter: 'html', description: 'A hello world page' })
  })

  it('declares every method it implements, and implements every one it declares', () => {
    const methods = createCodeMethods({ kit: {} })
    Object.keys(methods).sort().should.eql(Object.keys(METHOD_DECLARATIONS).sort())
  })

  it('creates a tree from a starter and lists it', async () => {
    const [tree] = await human.list()
    tree.should.match({ name: 'hello', description: 'A hello world page', files: 3 })
  })

  it('reads, writes and edits by address, returning addresses', async () => {
    const page = await agent.read('hello:index.html')
    page.address.should.equal('hello:index.html')
    const edited = await agent.edit('hello:index.html', 'Hello, world', 'Hello, Unknown', { message: 'greet' })
    edited.should.match({ address: 'hello:index.html', changed: true, problems: [] })
    ;(await agent.read('hello:index.html')).content.should.containEql('Hello, Unknown')
    const written = await agent.write('hello:app.js', 'import x from "./x.js"\n')
    written.problems.should.match([{ address: 'hello:app.js', message: './x.js is not a file in this tree' }])
    const [change] = await human.changes('hello:')
    change.actor.should.match({ type: 'agent', id: 'agent_9', onBehalfOf: 'user_123' })
  })

  it('lists the tree with addresses at every level', async () => {
    await human.write('hello:src/a.js', '')
    const root = await human.tree('hello:')
    root.address.should.equal('hello:')
    root.children[0].should.match({ address: 'hello:src', children: [{ address: 'hello:src/a.js' }] })
  })

  it('moves within a tree only', async () => {
    const moved = await human.move('hello:app.js', 'hello:src/app.js')
    moved.moved.should.eql([{ from: 'hello:app.js', to: 'hello:src/app.js' }])
    moved.problems.should.match([{ message: 'app.js is not a file in this tree' }])
    await human.create('other')
    await human.move('hello:style.css', 'other:style.css').should.be.rejectedWith(InvalidMoveError)
  })

  it('greps, pins, restores and checks', async () => {
    ;(await human.grep('Hello', 'hello:')).matches.should.match([{ address: 'hello:index.html' }])
    ;(await human.pin('hello', 'preact')).package.version.should.equal('1.2.3')
    ;(await human.deps('hello')).packages.map((each) => each.name).should.eql(['preact'])
    const [first] = (await human.changes('hello:')).slice(-1)
    const restored = await human.restore('hello:', first.id)
    restored.removed.should.eql(['hello:imports.json'])
    ;(await human.check('hello')).should.match({ files: 3, problems: [] })
  })

  it('gives history, a revision and a change', async () => {
    const { revisionId, changeId } = await human.write('hello:app.js', 'console.log(1)\n')
    const [latest] = await human.history('hello:app.js')
    latest.should.match({ address: 'hello:app.js', revisionId, action: 'updated' })
    ;(await human.getRevision('hello', revisionId)).previous.should.match({ address: 'hello:app.js' })
    ;(await human.getChange('hello', changeId)).files[0].patch.should.containEql('+console.log(1)')
  })

  it('refuses a call meant for another method, naming the right one', async () => {
    await human.rpc('code.write', { path: 'hello:a.js', oldString: 'a', newString: 'b' })
      .should.be.rejectedWith(ValidationError, { message: 'code.write does not take oldString: part of a file is changed with code.edit' })
    await human.rpc('code.edit', { path: 'hello:a.js', content: 'x', oldString: 'a', newString: 'b' })
      .should.be.rejectedWith(ValidationError, { message: /code.edit does not take content/ })
    await human.rpc('code.grep', { path: 'hello:', query: 'x', pattern: 'x' })
      .should.be.rejectedWith(ValidationError, { message: /code.grep takes a pattern/ })
    await human.rpc('code.restore', { path: 'hello:' })
      .should.be.rejectedWith(ValidationError, { message: 'code.restore needs changeId: say which change to restore to' })
  })

  it('maps domain errors to typed client errors', async () => {
    await human.read('nope:index.html').should.be.rejectedWith(NotFoundError)
    await human.edit('hello:index.html', 'absent', 'x').should.be.rejectedWith(EditMismatchError)
    const { revisionId } = await human.read('hello:app.js')
    await human.write('hello:app.js', 'a')
    await human.write('hello:app.js', 'b', { ifRevision: revisionId }).should.be.rejectedWith(RevisionConflictError)
    await human.read('hello:index.html', { offset: 0 }).should.be.rejectedWith(ValidationError)
  })

  it('authenticates and authorizes every call, and lists only what a caller may read', async () => {
    await api.client().list().should.be.rejectedWith(UnauthenticatedError)
    const reader = api.client('read-token')
    ;(await reader.read('hello:index.html')).path.should.equal('index.html')
    await reader.write('hello:a.js', 'x').should.be.rejectedWith(UnauthorizedError)
    await human.create('other')
    const guest = api.client('hello-token')
    ;(await guest.list()).map((tree) => tree.name).should.eql(['hello'])
    await guest.read('other:index.html').should.be.rejectedWith(UnauthorizedError)
  })

  it('answers JSON-RPC errors for unknown methods and bad requests', async () => {
    const response = await fetch(`${api.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer human-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'code.search', params: {} })
    })
    ;(await response.json()).error.code.should.equal(-32601)
    const bad = await fetch(`${api.baseUrl}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    ;(await bad.json()).error.code.should.equal(-32700)
  })
})
