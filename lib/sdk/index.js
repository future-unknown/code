/**
 * code-sdk — environment-neutral client for the code API.
 *
 * Works in Node.js and browsers; depends only on `fetch`. Hides the
 * JSON-RPC transport and maps API errors to typed error classes.
 * Contains no code domain rules. Paths are addresses, `<tree>:<path>`.
 */

import { errorFromRpc, NetworkError, RpcError } from './errors.js'

export * from './errors.js'

export class CodeClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl e.g. "http://localhost:3000"
   * @param {string} [options.token] bearer token
   * @param {typeof fetch} [options.fetch] injectable fetch for tests
   */
  constructor ({ baseUrl, token, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new NetworkError('baseUrl is required', { code: 'CONFIG' })
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
    this._fetch = fetchImpl || globalThis.fetch.bind(globalThis)
    this._nextId = 1
  }

  /** @private */
  async rpc (method, params) {
    const id = this._nextId++
    let response
    try {
      response = await this._fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      })
    } catch (error) {
      throw new NetworkError(`request failed: ${error.message}`, { code: 'NETWORK' })
    }
    let body
    try {
      body = await response.json()
    } catch {
      throw new RpcError(`invalid response (HTTP ${response.status})`, { code: 'RPC_ERROR' })
    }
    if (body.error) throw errorFromRpc(body.error)
    return body.result
  }

  /* Trees -------------------------------------------------------------- */

  /** Every tree the caller may read. */
  async list () {
    return this.rpc('code.list', {})
  }

  /**
   * @param {string} name
   * @param {{ title?: string, description?: string, starter?: string, message?: string }} [options]
   */
  async create (name, { title, description, starter, message } = {}) {
    return this.rpc('code.create', { name, title, description, starter, message })
  }

  /**
   * @param {string} tree
   * @param {{ title?: string|null, description?: string|null }} changes
   */
  async update (tree, { title, description } = {}) {
    return this.rpc('code.update', { tree, title, description })
  }

  /* Files: authored ---------------------------------------------------- */

  /** @param {string} path e.g. "hello:" or "hello:src" */
  async tree (path, { depth, changeId } = {}) {
    return this.rpc('code.tree', { path, depth, changeId })
  }

  /** @param {string} path e.g. "hello:index.html" */
  async read (path, { offset, limit, changeId } = {}) {
    return this.rpc('code.read', { path, offset, limit, changeId })
  }

  /**
   * Write a file whole: text as `content`, or bytes as `base64`.
   *
   * @param {string} path
   * @param {string} content
   * @param {{ base64?: boolean, ifRevision?: string, message?: string }} [options]
   *   `base64: true` sends content as base64
   */
  async write (path, content, { base64, ifRevision, message } = {}) {
    return this.rpc('code.write', base64
      ? { path, base64: content, ifRevision, message }
      : { path, content, ifRevision, message })
  }

  /** Replace one exact string in a text file. */
  async edit (path, oldString, newString, { replaceAll, ifRevision, message } = {}) {
    return this.rpc('code.edit', { path, oldString, newString, replaceAll, ifRevision, message })
  }

  async move (from, to, { ifRevision, message } = {}) {
    return this.rpc('code.move', { from, to, ifRevision, message })
  }

  async remove (path, { recursive, ifRevision, ifChange, message } = {}) {
    return this.rpc('code.remove', { path, recursive, ifRevision, ifChange, message })
  }

  async grep (pattern, path, { regex, ignoreCase, context, limit } = {}) {
    return this.rpc('code.grep', { pattern, path, regex, ignoreCase, context, limit })
  }

  /* Packages ------------------------------------------------------------ */

  async deps (tree) {
    return this.rpc('code.deps', { tree })
  }

  async pin (tree, pkg, { version, message } = {}) {
    return this.rpc('code.pin', { tree, package: pkg, version, message })
  }

  async unpin (tree, pkg, { message } = {}) {
    return this.rpc('code.unpin', { tree, package: pkg, message })
  }

  /* History -------------------------------------------------------------- */

  async history (path, { limit } = {}) {
    return this.rpc('code.history', { path, limit })
  }

  async getRevision (tree, revisionId) {
    return this.rpc('code.getRevision', { tree, revisionId })
  }

  async changes (path, { limit, before } = {}) {
    return this.rpc('code.changes', { path, limit, before })
  }

  async getChange (tree, changeId) {
    return this.rpc('code.getChange', { tree, changeId })
  }

  async restore (path, changeId, { ifChange, message } = {}) {
    return this.rpc('code.restore', { path, changeId, ifChange, message })
  }

  /* Check ----------------------------------------------------------------- */

  async check (tree, { changeId } = {}) {
    return this.rpc('code.check', { tree, changeId })
  }
}
