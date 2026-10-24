/**
 * Pluggable authentication for code-api.
 *
 * An auth implementation provides:
 *   authenticate(request) -> principal (throw UnauthenticatedError otherwise)
 *   authorize(principal, operation) -> void (throw UnauthorizedError otherwise)
 *
 * A principal carries the trusted audit actor passed down to code-kit:
 *   { actor: { type, id, onBehalfOf } }
 *
 * An operation is { action, tree, path }: the action one of
 * `code:read`, `code:write`, `code:create`; the tree's name (null for a
 * call that addresses no particular tree, such as code.list); and the
 * address the call acts on.
 */

import { CodeError } from '../kit/index.js'

export class UnauthenticatedError extends CodeError {
  constructor (message = 'authentication required', details) {
    super(message, { code: 'UNAUTHENTICATED', details })
  }
}

export class UnauthorizedError extends CodeError {
  constructor (message = 'operation not allowed', details) {
    super(message, { code: 'UNAUTHORIZED', details })
  }
}

/**
 * Minimal static bearer-token auth for development and tests.
 *
 * @param {{ tokens: Record<string, { actor: object, allow?: string[], trees?: string[] }> }} options
 *   `allow` optionally restricts a token to specific actions
 *   (e.g. ['code:read']); omitted means all actions. `trees`
 *   optionally restricts it to specific trees by name; omitted means
 *   all trees. A grant is the product of the two.
 */
export function createStaticTokenAuth ({ tokens }) {
  return {
    async authenticate (request) {
      const header = request.headers.authorization || ''
      const match = header.match(/^Bearer\s+(.+)$/i)
      if (!match) throw new UnauthenticatedError()
      const entry = tokens[match[1]]
      if (!entry) throw new UnauthenticatedError('invalid token')
      return { actor: entry.actor, allow: entry.allow ?? null, trees: entry.trees ?? null }
    },

    async authorize (principal, operation) {
      if (principal.allow && !principal.allow.includes(operation.action)) {
        throw new UnauthorizedError(`not allowed: ${operation.action}`, {
          action: operation.action,
          tree: operation.tree
        })
      }
      if (principal.trees && operation.tree !== null && !principal.trees.includes(operation.tree)) {
        throw new UnauthorizedError(`not allowed: tree ${operation.tree}`, {
          action: operation.action,
          tree: operation.tree
        })
      }
    }
  }
}
