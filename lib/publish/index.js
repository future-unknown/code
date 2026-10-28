/**
 * code-publish — a tree, as of one change, becomes the files a host
 * serves.
 *
 * Nothing is read from or written to a file system: the entries carry
 * each file's path, size and SHA-256, and read its contents from the
 * tree only when the host asks for them (surge-stream's publishEntries
 * sends the hashes first and uploads only what the host lacks).
 *
 * Files go as they are stored, except HTML pages, which gain the tree's
 * import map (imports.json) as an inline <script type="importmap"> at
 * the top of their head, so bare imports resolve with no bundler.
 * JSX and TypeScript are not transformed yet.
 */

import { createHash } from 'node:crypto'
import { parse as parseHtml } from 'parse5'
import { IMPORT_MAP_PATH, readImportMap } from '../kit/imports.js'

const HTML_PAGE = /\.html?$/i

function sha256 (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The files to publish a tree as, now or as of a change.
 *
 * @param {object} kit a code kit
 * @param {{ treeId: string, changeId?: number }} at
 * @returns {Promise<{ changeId: number|null, entries: Array<{ name: string, size: number, sha256: string, content: () => Buffer }> }>}
 */
export async function publishFiles (kit, { treeId, changeId }) {
  const snapshot = await kit.snapshot({ treeId, changeId })
  const mapFile = snapshot.files.find((file) => file.path === IMPORT_MAP_PATH && !file.binary)
  const importMap = mapFile ? inlineImportMap(mapFile.bytes().toString('utf8')) : null

  const entries = snapshot.files.map((file) => {
    if (importMap && !file.binary && HTML_PAGE.test(file.path)) {
      const page = Buffer.from(withImportMap(file.bytes().toString('utf8'), importMap), 'utf8')
      return { name: file.path, size: page.length, sha256: sha256(page), content: () => page }
    }
    return { name: file.path, size: file.size, sha256: file.hash, content: file.bytes }
  })
  return { changeId: snapshot.changeId, entries }
}

/**
 * The tree's import map as a page carries it, or null when it maps
 * nothing or can't be read (check reports why).
 */
export function inlineImportMap (text) {
  const { map, problem } = readImportMap(text)
  if (problem || Object.keys(map.imports).length === 0) return null
  // "</" can't appear inside a script element's text
  const json = JSON.stringify(map, null, 2).replace(/<\//g, '<\\/')
  return `<script type="importmap">\n${json}\n</script>`
}

/**
 * A page with the import map added, before anything that could load a
 * module: just inside <head>, else just inside <html>, else before the
 * page's first element. A page with an import map of its own keeps it
 * and gains none (check reports it).
 */
export function withImportMap (html, script) {
  const document = parseHtml(html, { sourceCodeLocationInfo: true })
  const elements = []
  const visit = (node) => {
    if (node.tagName) elements.push(node)
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(document)
  if (elements.some(isImportMap)) return html
  const opened = (name) => elements.find((node) => node.tagName === name && node.sourceCodeLocation?.startTag)
  const first = elements.find((node) => !IMPLIED.has(node.tagName) && node.sourceCodeLocation)
  const doctype = document.childNodes.find((node) => node.nodeName === '#documentType')
  const at = opened('head')?.sourceCodeLocation.startTag.endOffset ??
    opened('html')?.sourceCodeLocation.startTag.endOffset ??
    first?.sourceCodeLocation.startOffset ??
    doctype?.sourceCodeLocation?.endOffset ??
    0
  return `${html.slice(0, at)}\n${script}\n${html.slice(at)}`
}

// Elements a parser adds when a page leaves them out.
const IMPLIED = new Set(['html', 'head', 'body'])

function isImportMap (node) {
  return node.tagName === 'script' && node.attrs.some((attr) => attr.name === 'type' && attr.value.trim().toLowerCase() === 'importmap')
}
