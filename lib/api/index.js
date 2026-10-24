/**
 * code API layer.
 *
 * Two doors, one set of rules:
 *
 *   createCodeMethods({ kit, auth })  transport-neutral JSON-RPC method
 *                                     table — mount these on any host's
 *                                     RPC server (each method takes
 *                                     (principal, params))
 *
 *   createCodeRouter({ kit, auth })   an express.Router exposing the
 *                                     table at POST /rpc for standalone
 *                                     or embedded Express apps
 *
 * This layer owns authentication hooks, authorization checks, transport
 * validation, and error mapping. It contains no SQL and no domain rules:
 * addresses resolve to (treeId, path) and go to the kit, and every path
 * that comes back carries its address, so it pastes into the next call.
 */

import express from 'express'
import {
  CodeError,
  NotFoundError,
  InvalidMoveError,
  parseAddress,
  formatAddress
} from '../kit/index.js'
import { UnauthenticatedError, UnauthorizedError } from './auth.js'
import { METHOD_DECLARATIONS, validateParams } from './declarations.js'

export { createStaticTokenAuth, UnauthenticatedError, UnauthorizedError } from './auth.js'
export { METHOD_DECLARATIONS, validateParams } from './declarations.js'
export { openDatabase } from './db.js'

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  DOMAIN_ERROR: -32000
}

function addressed (tree, item) {
  return { ...item, address: formatAddress(tree, item.path) }
}

function addressedProblems (tree, problems) {
  return problems.map((problem) => addressed(tree, problem))
}

function addressedNode (tree, node) {
  const out = addressed(tree, node)
  if (node.children) out.children = node.children.map((child) => addressedNode(tree, child))
  return out
}

function addressedFiles (tree, change) {
  return {
    ...change,
    files: change.files.map((file) => ({
      ...addressed(tree, file),
      ...(file.from ? { fromAddress: formatAddress(tree, file.from) } : {})
    }))
  }
}

// A write's result: its address, and the tree's problems after it.
function addressedWrite (tree, result) {
  return { ...addressed(tree, result), problems: addressedProblems(tree, result.problems) }
}

/**
 * Build the transport-neutral method table. Every method has the shape
 * `(principal, params) => result` and throws domain errors; hosts map
 * those to their wire format (createCodeRouter does this for JSON-RPC).
 *
 * `auth.authorize(principal, operation)` is consulted per call when
 * provided; hosts that guard calls themselves may omit it.
 *
 * @param {{ kit: object, auth?: { authorize?: Function } }} options
 */
export function createCodeMethods ({ kit, auth }) {
  if (!kit) throw new Error('kit is required')
  const authorize = auth?.authorize
    ? auth.authorize.bind(auth)
    : async () => {}

  async function resolveTree (name) {
    const tree = await kit.findTree({ name })
    if (!tree) throw new NotFoundError(`no tree named ${name}`, { tree: name })
    return tree
  }

  // An address, resolved and authorized: the tree, and the path in it.
  async function at (principal, address, action) {
    const { tree: name, path } = parseAddress(address)
    const tree = await resolveTree(name)
    await authorize(principal, { action, tree: name, path: address })
    return { tree, name, path }
  }

  // A tree named alone, resolved and authorized.
  async function named (principal, name, action) {
    const { tree: parsed } = parseAddress(name)
    const tree = await resolveTree(parsed)
    await authorize(principal, { action, tree: parsed, path: formatAddress(parsed, '') })
    return { tree, name: parsed }
  }

  const table = {
    async 'code.list' (principal) {
      await authorize(principal, { action: 'code:read', tree: null, path: null })
      const trees = await kit.listTrees()
      // A listing shows what the principal may read: each tree is
      // authorized individually, and refused ones are simply absent.
      const visible = []
      for (const tree of trees) {
        try {
          await authorize(principal, { action: 'code:read', tree: tree.name, path: formatAddress(tree.name, '') })
          visible.push(tree)
        } catch (error) {
          if (!(error instanceof UnauthorizedError)) throw error
        }
      }
      return visible
    },

    async 'code.create' (principal, params) {
      await authorize(principal, { action: 'code:create', tree: params.name, path: formatAddress(params.name, '') })
      const result = await kit.createTree({
        name: params.name,
        title: params.title,
        description: params.description,
        starter: params.starter,
        actor: principal.actor,
        message: params.message
      })
      return { ...result, problems: addressedProblems(params.name, result.problems) }
    },

    async 'code.update' (principal, params) {
      const { tree } = await named(principal, params.tree, 'code:write')
      return kit.updateTree({ treeId: tree.id, title: params.title, description: params.description })
    },

    async 'code.tree' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:read')
      const root = await kit.listFiles({ treeId: tree.id, path, depth: params.depth, changeId: params.changeId })
      return addressedNode(name, root)
    },

    async 'code.read' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:read')
      const file = await kit.readFile({
        treeId: tree.id, path, offset: params.offset, limit: params.limit, changeId: params.changeId
      })
      return addressed(name, file)
    },

    async 'code.write' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:write')
      const result = await kit.writeFile({
        treeId: tree.id,
        path,
        content: params.content,
        base64: params.base64,
        ifRevision: params.ifRevision,
        actor: principal.actor,
        message: params.message
      })
      return addressedWrite(name, result)
    },

    async 'code.edit' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:write')
      const result = await kit.editFile({
        treeId: tree.id,
        path,
        oldString: params.oldString,
        newString: params.newString,
        replaceAll: params.replaceAll,
        ifRevision: params.ifRevision,
        actor: principal.actor,
        message: params.message
      })
      return addressedWrite(name, result)
    },

    async 'code.move' (principal, params) {
      const from = parseAddress(params.from)
      const to = parseAddress(params.to)
      if (from.tree !== to.tree) {
        throw new InvalidMoveError('a move stays in its tree; to copy between trees, read and write', { from: params.from, to: params.to })
      }
      const { tree, name } = await at(principal, params.from, 'code:write')
      const result = await kit.moveFile({
        treeId: tree.id,
        from: from.path,
        to: to.path,
        ifRevision: params.ifRevision,
        actor: principal.actor,
        message: params.message
      })
      return {
        ...result,
        from: formatAddress(name, result.from),
        to: formatAddress(name, result.to),
        moved: result.moved.map((pair) => ({ from: formatAddress(name, pair.from), to: formatAddress(name, pair.to) })),
        problems: addressedProblems(name, result.problems)
      }
    },

    async 'code.remove' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:write')
      const result = await kit.removeFile({
        treeId: tree.id,
        path,
        recursive: params.recursive,
        ifRevision: params.ifRevision,
        ifChange: params.ifChange,
        actor: principal.actor,
        message: params.message
      })
      return {
        ...addressed(name, result),
        removed: result.removed.map((each) => formatAddress(name, each)),
        problems: addressedProblems(name, result.problems)
      }
    },

    async 'code.grep' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:read')
      const result = await kit.grep({
        treeId: tree.id,
        path,
        pattern: params.pattern,
        regex: params.regex,
        ignoreCase: params.ignoreCase,
        context: params.context,
        limit: params.limit
      })
      return { ...result, matches: result.matches.map((match) => addressed(name, match)) }
    },

    async 'code.deps' (principal, params) {
      const { tree, name } = await named(principal, params.tree, 'code:read')
      return addressed(name, await kit.deps({ treeId: tree.id }))
    },

    async 'code.pin' (principal, params) {
      const { tree, name } = await named(principal, params.tree, 'code:write')
      const result = await kit.pin({
        treeId: tree.id, package: params.package, version: params.version, actor: principal.actor, message: params.message
      })
      return addressedWrite(name, result)
    },

    async 'code.unpin' (principal, params) {
      const { tree, name } = await named(principal, params.tree, 'code:write')
      const result = await kit.unpin({
        treeId: tree.id, package: params.package, actor: principal.actor, message: params.message
      })
      return addressedWrite(name, result)
    },

    async 'code.history' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:read')
      const revisions = await kit.fileHistory({ treeId: tree.id, path, limit: params.limit })
      return revisions.map((revision) => addressed(name, revision))
    },

    async 'code.getRevision' (principal, params) {
      const { tree, name } = await named(principal, params.tree, 'code:read')
      const revision = await kit.getRevision({ treeId: tree.id, revisionId: params.revisionId })
      return {
        ...addressed(name, revision),
        previous: revision.previous ? addressed(name, revision.previous) : null
      }
    },

    async 'code.changes' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:read')
      const changes = await kit.getChanges({ treeId: tree.id, path, limit: params.limit, before: params.before })
      return changes.map((change) => addressedFiles(name, change))
    },

    async 'code.getChange' (principal, params) {
      const { tree, name } = await named(principal, params.tree, 'code:read')
      return addressedFiles(name, await kit.getChange({ treeId: tree.id, changeId: params.changeId }))
    },

    async 'code.restore' (principal, params) {
      const { tree, name, path } = await at(principal, params.path, 'code:write')
      const result = await kit.restore({
        treeId: tree.id,
        path,
        changeId: params.changeId,
        ifChange: params.ifChange,
        actor: principal.actor,
        message: params.message
      })
      return {
        ...addressed(name, result),
        restored: result.restored.map((each) => formatAddress(name, each)),
        removed: result.removed.map((each) => formatAddress(name, each)),
        problems: addressedProblems(name, result.problems)
      }
    },

    async 'code.check' (principal, params) {
      const { tree, name } = await named(principal, params.tree, 'code:read')
      const result = await kit.check({ treeId: tree.id, changeId: params.changeId })
      return { ...result, problems: addressedProblems(name, result.problems) }
    }
  }

  // Every call is checked against its declaration first, so a handler
  // reads params already known to be shaped as declared.
  const methods = {}
  for (const [name, handler] of Object.entries(table)) {
    if (!METHOD_DECLARATIONS[name]) throw new Error(`${name} has no declaration`)
    methods[name] = async (principal, params = {}) => {
      validateParams(name, params)
      return handler(principal, params)
    }
  }
  for (const name of Object.keys(METHOD_DECLARATIONS)) {
    if (!methods[name]) throw new Error(`${name} is declared but not implemented`)
  }
  return methods
}

function rpcError (id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } }
}

function mapError (id, error) {
  if (error instanceof CodeError) {
    return rpcError(id, RPC.DOMAIN_ERROR, error.message, {
      code: error.code,
      details: error.details
    })
  }
  return rpcError(id, RPC.INTERNAL_ERROR, 'internal error')
}

/**
 * Express adapter: mounts the method table at POST /rpc (plus /health
 * and permissive CORS for browser clients).
 *
 * @param {object} options
 * @param {object} options.kit code-kit instance
 * @param {{ authenticate: Function, authorize: Function }} options.auth
 * @param {string} [options.bodyLimit] express.json limit (default '4mb')
 * @param {(error: Error) => void} [options.onError] hook for unexpected errors
 */
export function createCodeRouter ({ kit, auth, bodyLimit = '4mb', onError } = {}) {
  if (!auth || typeof auth.authenticate !== 'function' || typeof auth.authorize !== 'function') {
    throw new Error('auth with authenticate and authorize is required')
  }
  const methods = createCodeMethods({ kit, auth })
  const router = express.Router()

  router.use((request, response, next) => {
    response.set('access-control-allow-origin', '*')
    response.set('access-control-allow-methods', 'POST, OPTIONS')
    response.set('access-control-allow-headers', 'content-type, authorization')
    if (request.method === 'OPTIONS') return response.status(204).end()
    next()
  })

  router.get('/health', (request, response) => response.json({ ok: true }))

  router.post('/rpc', express.json({ limit: bodyLimit }), async (request, response) => {
    const body = request.body
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return response.json(rpcError(body?.id, RPC.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'))
    }
    const { id, method } = body
    const params = body.params ?? {}
    if (typeof params !== 'object' || Array.isArray(params)) {
      return response.json(rpcError(id, RPC.INVALID_PARAMS, 'params must be an object'))
    }
    const handler = methods[method]
    if (!handler) {
      return response.json(rpcError(id, RPC.METHOD_NOT_FOUND, `method not found: ${method}`))
    }
    try {
      const principal = await auth.authenticate(request)
      if (!principal || !principal.actor) throw new UnauthenticatedError()
      const result = await handler(principal, params)
      return response.json({ jsonrpc: '2.0', id: id ?? null, result })
    } catch (error) {
      if (!(error instanceof CodeError) && onError) onError(error)
      return response.json(mapError(id, error))
    }
  })

  // Body-parse failures (malformed JSON, oversized payloads) from
  // express.json surface here.
  router.use('/rpc', (error, request, response, next) => {
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return response.status(200).json(rpcError(null, RPC.PARSE_ERROR, 'parse error'))
    }
    if (onError) onError(error)
    return response.status(200).json(rpcError(null, RPC.INTERNAL_ERROR, 'internal error'))
  })

  return router
}
