/**
 * The import map: how a tree's code names packages without a bundler.
 *
 * A tree keeps its map in `imports.json` at its root, in the browser's
 * own import-map shape. Publishing adds it to each HTML page. Packages
 * come from a CDN at exact versions: pinning `react` writes
 *
 *   "react":  "https://esm.sh/react@18.3.1",
 *   "react/": "https://esm.sh/react@18.3.1/"
 *
 * so `react` and its subpaths (`react/jsx-runtime`) both resolve, and a
 * site never changes under you when a package does.
 */

import semver from 'semver'
import { NotFoundError, ValidationError } from './errors.js'

export const IMPORT_MAP_PATH = 'imports.json'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_CDN = 'https://esm.sh'

// npm's rules for a package name: lowercase, URL-safe, optionally
// scoped, at most 214 characters.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const MAX_PACKAGE_NAME = 214

/**
 * Split `react@18.3.1` or `@scope/pkg@^1` into name and version (or
 * range, or dist-tag). A version given separately wins.
 *
 * @param {string} spec
 * @param {string} [version]
 */
export function parsePackageSpec (spec, version) {
  if (typeof spec !== 'string' || spec === '') {
    throw new ValidationError('package is required, e.g. react or react@18.3.1', {})
  }
  const at = spec.indexOf('@', 1)
  const name = at === -1 ? spec : spec.slice(0, at)
  const inline = at === -1 ? undefined : spec.slice(at + 1)
  if (!PACKAGE_NAME.test(name) || name.length > MAX_PACKAGE_NAME) {
    throw new ValidationError(`not a package name: ${name}`, { package: spec })
  }
  const wanted = version ?? inline
  if (wanted !== undefined && (typeof wanted !== 'string' || wanted === '')) {
    throw new ValidationError('version must be a version, range or tag', { version: wanted })
  }
  return { name, version: wanted }
}

/**
 * Read an import map's text. Returns the map, or the problem that
 * makes it unreadable.
 *
 * @param {string|null} text the file's contents, or null when absent
 * @returns {{ map: { imports: Record<string, string>, scopes?: object }, problem?: string }}
 */
export function readImportMap (text) {
  if (text === null || text === undefined) return { map: { imports: {} } }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { map: { imports: {} }, problem: `imports.json is not JSON: ${error.message}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { map: { imports: {} }, problem: 'imports.json must be an object with an "imports" field' }
  }
  const imports = parsed.imports ?? {}
  if (!imports || typeof imports !== 'object' || Array.isArray(imports)) {
    return { map: { imports: {} }, problem: '"imports" in imports.json must map names to URLs' }
  }
  for (const [key, value] of Object.entries(imports)) {
    if (typeof value !== 'string' || value === '') {
      return { map: { imports: {} }, problem: `imports.json maps ${key} to something other than a URL` }
    }
    if (key.endsWith('/') && !value.endsWith('/')) {
      return { map: { imports: {} }, problem: `imports.json: ${key} ends with a slash, so its URL must too` }
    }
  }
  return { map: { ...parsed, imports } }
}

/** The map as a file: two-space JSON, names sorted, a final newline. */
export function formatImportMap (map) {
  const imports = Object.fromEntries(Object.keys(map.imports).sort().map((key) => [key, map.imports[key]]))
  return `${JSON.stringify({ ...map, imports }, null, 2)}\n`
}

/**
 * Where a bare specifier resolves, by the browser's rule: an exact
 * entry, else the longest entry ending in a slash that prefixes it.
 *
 * @returns {string|null}
 */
export function lookupImport (map, specifier) {
  const imports = map.imports
  if (Object.hasOwn(imports, specifier)) return imports[specifier]
  let best = null
  for (const key of Object.keys(imports)) {
    if (key.endsWith('/') && specifier.startsWith(key) && (!best || key.length > best.length)) best = key
  }
  return best ? imports[best] + specifier.slice(best.length) : null
}

// A package from its GitHub repository, at a release tag: the one the
// host names, or an exact version asked for.
function resolveHosted (name, wanted, { repo, version }, cdn) {
  if (wanted !== undefined && !semver.valid(wanted)) {
    throw new ValidationError(`${name} is pinned at an exact version, e.g. ${version}`, { package: name, version: wanted })
  }
  const exact = wanted ?? version
  return { name, version: exact, url: `${cdn}/gh/${repo}@v${exact}` }
}

/** The packages a map pins, as name, version and URL. */
export function pinnedPackages (map, cdn = DEFAULT_CDN) {
  const prefix = `${cdn}/`
  const packages = []
  for (const [key, url] of Object.entries(map.imports)) {
    if (key.endsWith('/')) continue
    const pinned = url.startsWith(prefix) ? parsePinnedUrl(url.slice(prefix.length)) : null
    packages.push({ name: key, version: pinned?.name === key ? pinned.version : null, url })
  }
  return packages.sort((a, b) => (a.name < b.name ? -1 : 1))
}

function parsePinnedUrl (rest) {
  // a hosted package, gh/<owner>/<repo>@v<version>: named by its repo
  const hosted = /^gh\/[^/]+\/([^/@]+)@v?([^/?#]+)/.exec(rest)
  if (hosted) return { name: hosted[1], version: hosted[2] }
  const path = rest.split(/[?#]/)[0]
  const scoped = path.startsWith('@')
  const parts = path.split('/')
  const head = scoped ? `${parts[0]}/${parts[1]}` : parts[0]
  const at = head.indexOf('@', 1)
  if (at === -1) return null
  return { name: head.slice(0, at), version: head.slice(at + 1) }
}

/** The map with a package pinned at `url`, subpaths included. */
export function withPin (map, name, url) {
  return { ...map, imports: { ...map.imports, [name]: url, [`${name}/`]: `${url}/` } }
}

/** The map without a package. */
export function withoutPin (map, name) {
  const imports = { ...map.imports }
  delete imports[name]
  delete imports[`${name}/`]
  return { ...map, imports }
}

/**
 * A package resolver that asks the npm registry which version a name
 * and an optional version, range or dist-tag mean, and pins it on a
 * CDN that serves npm packages as ES modules.
 *
 * `hosted` names packages that live in a GitHub repository instead of
 * on npm, which the CDN builds from a release tag: name → { repo,
 * version }, pinned at that version unless an exact one is asked for
 * (`wiki` → https://esm.sh/gh/future-unknown/wiki@v0.25.0, so
 * `wiki/session` resolves by the package's own exports).
 *
 * @param {{ fetch?: typeof fetch, registry?: string, cdn?: string, hosted?: Record<string, { repo: string, version: string }> }} [options]
 * @returns {(name: string, wanted?: string) => Promise<{ name: string, version: string, url: string }>}
 */
export function createRegistryResolver ({ fetch: fetchImpl = globalThis.fetch, registry = DEFAULT_REGISTRY, cdn = DEFAULT_CDN, hosted = {} } = {}) {
  return async function resolvePackage (name, wanted) {
    if (Object.hasOwn(hosted, name)) return resolveHosted(name, wanted, hosted[name], cdn)
    const response = await fetchImpl(`${registry}/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' }
    })
    if (response.status === 404) throw new NotFoundError(`no package named ${name}`, { package: name })
    if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}`)
    const document = await response.json()
    const versions = Object.keys(document.versions ?? {})
    const tags = document['dist-tags'] ?? {}
    const version = wanted === undefined
      ? tags.latest
      : tags[wanted] ?? (versions.includes(wanted) ? wanted : semver.maxSatisfying(versions, wanted))
    if (!version) {
      throw new NotFoundError(`${name} has no version matching ${wanted}`, { package: name, version: wanted })
    }
    return { name, version, url: `${cdn}/${name}@${version}` }
  }
}
