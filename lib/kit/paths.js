/**
 * Tree names, file paths and addresses.
 *
 * A tree is named like a wiki: lowercase letters, digits and hyphens.
 * A file path is slash-separated, relative to the tree's root, with no
 * empty, `.` or `..` segments. An address joins the two with a colon —
 * `hello:src/app.js` — because file names carry dots; `hello:` (or
 * `hello`) is the tree's root.
 */

import { ValidationError } from './errors.js'

const TREE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SEGMENT = /^[A-Za-z0-9._@+~-]+$/
export const MAX_PATH_LENGTH = 512

/** @param {unknown} name */
export function assertTreeName (name) {
  if (typeof name !== 'string' || !TREE_NAME.test(name)) {
    throw new ValidationError('a tree name is lowercase letters, digits and hyphens, at most 63, starting and ending with a letter or digit', { name })
  }
}

/**
 * Normalize a file path: a leading or trailing slash is dropped, and
 * '' is the tree's root.
 *
 * @param {unknown} path
 * @returns {string}
 */
export function parseFilePath (path) {
  if (typeof path !== 'string') throw new ValidationError('a path must be a string', { path })
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '')
  if (trimmed === '') return ''
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new ValidationError(`a path must be ${MAX_PATH_LENGTH} characters or fewer`, { path })
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
      throw new ValidationError(`not a valid path: ${path} (segments are letters, digits and . _ @ + ~ -, never empty, . or ..)`, { path })
    }
  }
  return trimmed
}

/**
 * Split an address into its tree and path.
 *
 * @param {unknown} address
 * @returns {{ tree: string, path: string }}
 */
export function parseAddress (address) {
  if (typeof address !== 'string' || address === '') {
    throw new ValidationError('an address is <tree>:<path>', { address })
  }
  const colon = address.indexOf(':')
  const tree = colon === -1 ? address : address.slice(0, colon)
  const path = colon === -1 ? '' : address.slice(colon + 1)
  if (!TREE_NAME.test(tree)) {
    throw new ValidationError(`an address is <tree>:<path>, and ${JSON.stringify(tree)} is not a tree name`, { address })
  }
  return { tree, path: parseFilePath(path) }
}

export function formatAddress (tree, path) {
  return `${tree}:${path}`
}

export function dirname (path) {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

export function basename (path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function extname (path) {
  const name = basename(path)
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at).toLowerCase()
}

/** Whether `path` is `dir` itself or inside it ('' holds everything). */
export function isWithin (path, dir) {
  return dir === '' || path === dir || path.startsWith(`${dir}/`)
}

/**
 * Resolve a reference from a file to a tree path, the way a browser
 * resolves a URL: relative to the file's folder, or from the root when
 * it starts with a slash. Returns null for a reference that leaves the
 * tree.
 *
 * @param {string} from the referring file's path
 * @param {string} reference
 */
export function resolveReference (from, reference) {
  const parts = reference.startsWith('/') ? [] : dirname(from).split('/').filter(Boolean)
  for (const segment of reference.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}
