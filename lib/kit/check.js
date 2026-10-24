/**
 * Checks: what stands in for "run it and see" when there is no build
 * and no filesystem.
 *
 * Each file is analyzed alone — parsed, and its references collected —
 * by `analyze`, which depends only on the file's extension and text,
 * so callers cache it by content. `findProblems` then resolves every
 * reference against the tree the way a browser would: relative paths
 * to files that must exist exactly (browsers add no extensions), bare
 * package names through the import map, URLs left alone.
 */

import { transformSync } from 'esbuild'
import { init as initLexer, parse as lexModule } from 'es-module-lexer'
import { parse as parseHtml } from 'parse5'
import { extname, resolveReference } from './paths.js'
import { IMPORT_MAP_PATH, lookupImport, readImportMap } from './imports.js'

const SCRIPT_LOADERS = Object.freeze({
  '.js': 'js', '.mjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.tsx': 'tsx'
})
const HTML_EXTENSIONS = new Set(['.html', '.htm'])

// The extensions a browser would not add for you, tried when a
// relative import names no file, to say which one was meant.
const SUGGESTED_EXTENSIONS = ['.js', '.mjs', '.jsx', '.ts', '.tsx']

// Inline scripts the page runs as JavaScript; anything else (JSON,
// templates) is data.
const SCRIPT_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript'])

// <link rel> values whose href the page loads.
const LOADED_LINKS = new Set(['stylesheet', 'modulepreload', 'preload', 'icon', 'manifest', 'apple-touch-icon'])

// Elements whose src the page loads.
const SOURCED_ELEMENTS = new Set(['img', 'source', 'video', 'audio', 'track', 'iframe', 'embed'])

// Node's built-in modules, named without the node: prefix, which an
// agent reaching for a server habit might import.
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'crypto', 'child_process', 'http', 'https', 'net', 'stream', 'zlib', 'worker_threads', 'fs/promises'
])

const TSCONFIG = Object.freeze({ compilerOptions: { verbatimModuleSyntax: true } })

/** Load the module lexer; call once before analyze. */
export async function ready () {
  await initLexer
}

/**
 * A file's own problems and the references it makes.
 *
 * @param {string} path used for its extension alone
 * @param {string} text
 * @returns {{ problems: Array<{ line: number|null, column: number|null, message: string }>,
 *             refs: Array<{ specifier: string, kind: 'import'|'asset', line: number|null, column: number|null }> }}
 */
export function analyze (path, text) {
  const ext = extname(path)
  if (SCRIPT_LOADERS[ext]) return analyzeScript(SCRIPT_LOADERS[ext], text, { module: true })
  if (HTML_EXTENSIONS.has(ext)) return analyzeHtml(text)
  if (ext === '.css') return analyzeCss(text)
  if (ext === '.json') return analyzeJson(text)
  return { problems: [], refs: [] }
}

function analyzeScript (loader, text, { module, lineOffset = 0 }) {
  const shift = (line) => (line === null ? null : line + lineOffset)
  try {
    transformSync(text, { loader, jsx: 'transform', logLevel: 'silent', tsconfigRaw: TSCONFIG })
  } catch (error) {
    const errors = error.errors?.length ? error.errors : [{ text: error.message }]
    return {
      problems: errors.map((e) => ({
        line: shift(e.location?.line ?? null),
        column: e.location ? e.location.column + 1 : null,
        message: e.text
      })),
      refs: []
    }
  }
  if (!module) return { problems: [], refs: [] }
  return { problems: [], refs: scriptImports(loader, text).map((ref) => ({ ...ref, line: shift(ref.line) })) }
}

// The imports a script makes, with where each is written. The lexer
// reads JavaScript and erasable TypeScript; JSX it cannot, so a file
// it refuses is lexed as esbuild compiles it, and each specifier found
// again in the source to say where.
function scriptImports (loader, text) {
  let imports
  let positioned = true
  try {
    [imports] = lexModule(text)
  } catch {
    const { code } = transformSync(text, { loader, jsx: 'transform', logLevel: 'silent', tsconfigRaw: TSCONFIG })
    ;[imports] = lexModule(code)
    positioned = false
  }
  const refs = []
  for (const entry of imports) {
    if (typeof entry.specifier !== 'string' || entry.typeOnly) continue
    const at = positioned ? entry.start : findQuoted(text, entry.specifier)
    refs.push({ specifier: entry.specifier, kind: 'import', ...position(text, at) })
  }
  return refs
}

function findQuoted (text, specifier) {
  for (const quote of ['"', "'", '`']) {
    const at = text.indexOf(`${quote}${specifier}${quote}`)
    if (at !== -1) return at + 1
  }
  return -1
}

function position (text, index) {
  if (index < 0) return { line: null, column: null }
  let line = 1
  let lineStart = 0
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: index - lineStart + 1 }
}

function analyzeHtml (text) {
  const problems = []
  const refs = []
  const document = parseHtml(text, { sourceCodeLocationInfo: true })
  const visit = (node) => {
    if (node.tagName) inspectElement(node, problems, refs)
    for (const child of node.childNodes ?? []) visit(child)
    if (node.content) visit(node.content)
  }
  visit(document)
  return { problems, refs }
}

function inspectElement (node, problems, refs) {
  const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]))
  const at = (name) => {
    const location = node.sourceCodeLocation?.attrs?.[name] ?? node.sourceCodeLocation
    return location ? { line: location.startLine, column: location.startCol } : { line: null, column: null }
  }
  const asset = (name) => {
    if (attrs[name] !== undefined) refs.push({ specifier: attrs[name], kind: 'asset', ...at(name) })
  }
  const tag = node.tagName
  if (tag === 'script') {
    const type = (attrs.type ?? '').trim().toLowerCase()
    if (type === 'importmap') {
      problems.push({ ...at('type'), message: 'this tree\'s import map is imports.json, which publishing adds to each page; pin packages with code.pin instead of an inline map' })
      return
    }
    if (attrs.src !== undefined) return asset('src')
    if (!SCRIPT_TYPES.has(type)) return
    const body = node.childNodes[0]
    if (!body?.value) return
    const lineOffset = (body.sourceCodeLocation?.startLine ?? 1) - 1
    const result = analyzeScript('js', body.value, { module: type === 'module', lineOffset })
    problems.push(...result.problems)
    refs.push(...result.refs)
    return
  }
  if (tag === 'link') {
    const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/)
    if (rels.some((rel) => LOADED_LINKS.has(rel))) asset('href')
    return
  }
  if (SOURCED_ELEMENTS.has(tag)) asset('src')
}

const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

function analyzeCss (text) {
  const problems = []
  try {
    transformSync(text, { loader: 'css', logLevel: 'silent' })
  } catch (error) {
    for (const e of error.errors ?? [{ text: error.message }]) {
      problems.push({ line: e.location?.line ?? null, column: e.location ? e.location.column + 1 : null, message: e.text })
    }
  }
  const refs = []
  const seen = new Set()
  for (const pattern of [CSS_IMPORT, CSS_URL]) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index + match[0].indexOf(match[2])
      if (seen.has(index)) continue
      seen.add(index)
      refs.push({ specifier: match[2], kind: 'asset', ...position(text, index) })
    }
  }
  return { problems, refs }
}

function analyzeJson (text) {
  try {
    JSON.parse(text)
    return { problems: [], refs: [] }
  } catch (error) {
    const at = /position (\d+)/.exec(error.message)
    return { problems: [{ ...(at ? position(text, Number(at[1])) : { line: null, column: null }), message: error.message }], refs: [] }
  }
}

/**
 * Every problem in a tree: each file's own, and each reference that
 * resolves to nothing.
 *
 * @param {{ files: Array<{ path: string, analysis: ReturnType<typeof analyze>|null }>, importMap: string|null }} tree
 *   `analysis` is null for a binary file; `importMap` is imports.json's text, or null without one
 * @returns {Array<{ path: string, line: number|null, column: number|null, message: string }>}
 */
export function findProblems ({ files, importMap }) {
  const paths = new Set(files.map((file) => file.path))
  const { map, problem } = readImportMap(importMap)
  const problems = []
  if (problem) problems.push({ path: IMPORT_MAP_PATH, line: null, column: null, message: problem })
  for (const { path, analysis } of files) {
    if (!analysis) continue
    for (const own of analysis.problems) problems.push({ path, ...own })
    for (const ref of analysis.refs) {
      const message = referenceProblem(path, ref, paths, map)
      if (message) problems.push({ path, line: ref.line, column: ref.column, message })
    }
  }
  return problems.sort(byPlace)
}

function byPlace (a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)
}

function referenceProblem (from, ref, paths, map) {
  const specifier = ref.specifier.trim()
  if (specifier === '' || specifier.startsWith('#') || specifier.startsWith('//')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return specifier.startsWith('node:')
      ? `${specifier} is a Node module; a site runs in the browser`
      : null
  }
  const isPath = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')
  if (ref.kind === 'import' && !isPath) {
    if (lookupImport(map, specifier) !== null) return null
    if (NODE_BUILTINS.has(specifier)) return `${specifier} is a Node module; a site runs in the browser`
    if (paths.has(resolveReference(from, specifier))) {
      return `${specifier} reads as a package name; write ./${specifier} for the file`
    }
    return `${specifier} is not in the import map; pin ${packageOf(specifier)} with code.pin`
  }
  const target = resolveReference(from, decode(specifier.split(/[?#]/)[0]))
  if (target === null) return `${specifier} points outside the tree`
  if (paths.has(target)) return null
  if (ref.kind === 'asset') {
    const index = target === '' ? 'index.html' : `${target}/index.html`
    if (paths.has(index)) return null
    return `${specifier} is not a file in this tree`
  }
  for (const ext of SUGGESTED_EXTENSIONS) {
    if (paths.has(`${target}${ext}`)) return `${specifier} is not a file; browsers add no extensions, so write ${specifier}${ext}`
  }
  if (paths.has(`${target}/index.js`)) return `${specifier} is a folder; browsers add no index, so write ${specifier.replace(/\/$/, '')}/index.js`
  return `${specifier} is not a file in this tree`
}

function packageOf (specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function decode (path) {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}
