/**
 * The code method table, declared: every method's params, what it
 * returns, the action it exercises, and — in words — what it does and
 * what each param means. One source feeds two readers — the method
 * table validates each call against it before the handler runs, and a
 * host's discovery document publishes it — so what a client is told
 * and what the server checks cannot drift apart.
 *
 * Param types are `string`, `number`, `boolean`, or `object`, with a
 * trailing `?` when optional. A required param must be present and not
 * null; an optional one, when given, must be of its type. Finer rules
 * stay with the kit, which knows them. `misuse` names params that mark
 * a call meant for another method — a required one left out, or one
 * this method does not take — with the words that point there.
 *
 * Path params take addresses, `<tree>:<path>` (`hello:src/app.js`;
 * `hello:` is the tree's root), and `tree` takes a name alone. The
 * verbs are the wiki's where the meaning is the same: files are read,
 * written, edited, moved and removed like pages, and a tree's history
 * is its changes.
 */

import { ValidationError } from '../kit/index.js'

const TYPE_PATTERN = /^(string|number|boolean|object)(\?)?$/

export const METHOD_DECLARATIONS = Object.freeze({
  // Trees
  'code.list': {
    describe: 'Every tree the caller may read: its name, title, description, file count and latest change.',
    params: {},
    about: {},
    returns: 'tree[]',
    action: 'read'
  },
  'code.create': {
    describe: 'Create a tree, empty or from a starter, whose files are its first change.',
    params: { name: 'string', title: 'string?', description: 'string?', starter: 'string?', message: 'string?' },
    about: { name: 'the tree\'s name: lowercase letters, digits and hyphens', title: 'a title for people', description: 'a sentence or two on what the tree is for', starter: 'begin from a starter\'s files: html', message: 'a note on the first change' },
    returns: 'created',
    action: 'create'
  },
  'code.update': {
    describe: 'Change what a tree says about itself: its title and description.',
    params: { tree: 'string', title: 'string?', description: 'string?' },
    about: { tree: 'the tree\'s name', title: 'the new title, or null to clear it', description: 'the new description, or null to clear it' },
    returns: 'tree',
    action: 'write'
  },

  // Files: authored, like wiki pages
  'code.tree': {
    describe: 'The files and folders under a path, folders first, now or as of a change.',
    params: { path: 'string', depth: 'number?', changeId: 'number?' },
    about: { path: 'the address to start from; the tree\'s name and a colon is the whole tree', depth: 'how many levels down to include', changeId: 'the tree as of this change' },
    returns: 'folder',
    action: 'read'
  },
  'code.read': {
    describe: 'Read one file: text as content (a range of lines with offset and limit), a binary file as base64, with its revision.',
    params: { path: 'string', offset: 'number?', limit: 'number?', changeId: 'number?' },
    about: { path: 'the file\'s address', offset: 'the first line to return, counting from 1', limit: 'at most this many lines', changeId: 'the file as of this change' },
    returns: 'file',
    action: 'read',
    misuse: { pattern: 'matching lines are found with code.grep' }
  },
  'code.write': {
    describe: 'Write a file whole: create it, or replace its contents, guarded by the revision the caller last read. Returns the change and the tree\'s problems after it.',
    params: { path: 'string', content: 'string?', base64: 'string?', ifRevision: 'string?', message: 'string?' },
    about: { path: 'the file\'s address', content: 'the whole text of the file', base64: 'the whole file as base64, for a binary file', ifRevision: 'refuse unless the file is still at this revision', message: 'a note on the change' },
    returns: 'written',
    action: 'write',
    misuse: { oldString: 'part of a file is changed with code.edit', newString: 'part of a file is changed with code.edit' }
  },
  'code.edit': {
    describe: 'Change part of a text file: replace one exact string. Refused unless the string occurs exactly once, or replaceAll is given. Returns the change and the tree\'s problems after it.',
    params: { path: 'string', oldString: 'string', newString: 'string', replaceAll: 'boolean?', ifRevision: 'string?', message: 'string?' },
    about: { path: 'the file\'s address', oldString: 'the exact text to replace, with enough around it to occur once', newString: 'the text to put in its place', replaceAll: 'replace every occurrence', ifRevision: 'refuse unless the file is still at this revision', message: 'a note on the change' },
    returns: 'written',
    action: 'write',
    misuse: { content: 'a whole file is written with code.write' }
  },
  'code.move': {
    describe: 'Move or rename a file, or a folder and everything in it.',
    params: { from: 'string', to: 'string', ifRevision: 'string?', message: 'string?' },
    about: { from: 'the address now', to: 'the address it should have, in the same tree', ifRevision: 'moving one file: refuse unless it is still at this revision', message: 'a note on the change' },
    returns: 'moved',
    action: 'write'
  },
  'code.remove': {
    describe: 'Remove a file, or a folder and everything in it. A tree itself is not removed.',
    params: { path: 'string', recursive: 'boolean?', ifRevision: 'string?', ifChange: 'number?', message: 'string?' },
    about: { path: 'the address of a file or folder', recursive: 'remove a folder and everything in it', ifRevision: 'removing one file: refuse unless it is still at this revision', ifChange: 'refuse unless the tree is still at this change', message: 'a note on the change' },
    returns: 'removed',
    action: 'write'
  },
  'code.grep': {
    describe: 'Matching lines under a path, as path and line number: a literal string unless regex, optionally with lines of context.',
    params: { pattern: 'string', path: 'string', regex: 'boolean?', ignoreCase: 'boolean?', context: 'number?', limit: 'number?' },
    about: { pattern: 'the text, or with regex the regular expression, to find', path: 'the address to search under; the tree\'s name and a colon is the whole tree', regex: 'read pattern as a JavaScript regular expression', ignoreCase: 'match regardless of case', context: 'lines of context before and after each match', limit: 'at most this many matches' },
    returns: 'matches',
    action: 'read',
    misuse: { query: 'code.grep takes a pattern' }
  },

  // Packages: the import map, imports.json
  'code.deps': {
    describe: 'The packages the tree\'s import map (imports.json) pins, each with its version and URL.',
    params: { tree: 'string' },
    about: { tree: 'the tree\'s name' },
    returns: 'deps',
    action: 'read'
  },
  'code.pin': {
    describe: 'Pin a package in the import map at an exact version, served as ES modules: the latest, or the one a version, range or tag means. The package\'s subpaths resolve too.',
    params: { tree: 'string', package: 'string', version: 'string?', message: 'string?' },
    about: { tree: 'the tree\'s name', package: 'the npm package name, optionally with @version', version: 'a version, range or tag; without one, the latest', message: 'a note on the change' },
    returns: 'pinned',
    action: 'write'
  },
  'code.unpin': {
    describe: 'Drop a package from the import map.',
    params: { tree: 'string', package: 'string', message: 'string?' },
    about: { tree: 'the tree\'s name', package: 'the package name', message: 'a note on the change' },
    returns: 'unpinned',
    action: 'write'
  },

  // History: of one file, or of the tree
  'code.history': {
    describe: 'One file\'s revisions, newest first, following it back through moves; each names its change, actor and message.',
    params: { path: 'string', limit: 'number?' },
    about: { path: 'the file\'s address', limit: 'at most this many revisions' },
    returns: 'revision[]',
    action: 'read'
  },
  'code.getRevision': {
    describe: 'One revision of a file with its contents, and the revision before it, for a diff.',
    params: { tree: 'string', revisionId: 'string' },
    about: { tree: 'the tree\'s name', revisionId: 'the revision\'s id, from code.history or code.read' },
    returns: 'revision',
    action: 'read'
  },
  'code.changes': {
    describe: 'What changed across the tree, or under a path, newest first, each change with the files it touched.',
    params: { path: 'string', limit: 'number?', before: 'number?' },
    about: { path: 'the address to look under; the tree\'s name and a colon is the whole tree', limit: 'at most this many changes', before: 'only changes older than this change id' },
    returns: 'change[]',
    action: 'read'
  },
  'code.getChange': {
    describe: 'One change: who made it and why, and what it did to each file, as a unified patch per text file.',
    params: { tree: 'string', changeId: 'number' },
    about: { tree: 'the tree\'s name', changeId: 'the change\'s id' },
    returns: 'change',
    action: 'read'
  },
  'code.restore': {
    describe: 'Put a file, a folder, or the whole tree back as it stood after a change, as a new change.',
    params: { path: 'string', changeId: 'number', ifChange: 'number?', message: 'string?' },
    about: { path: 'the address to restore; the tree\'s name and a colon restores everything', changeId: 'the change to restore to', ifChange: 'refuse unless the tree is still at this change', message: 'a note on the change' },
    returns: 'restored',
    action: 'write',
    misuse: { changeId: 'say which change to restore to' }
  },

  // Check
  'code.check': {
    describe: 'Every problem in the tree, now or as of a change: files that do not parse, imports and page references that resolve to nothing, packages not in the import map.',
    params: { tree: 'string', changeId: 'number?' },
    about: { tree: 'the tree\'s name', changeId: 'check the tree as of this change' },
    returns: 'checked',
    action: 'read'
  }
})

for (const [name, declaration] of Object.entries(METHOD_DECLARATIONS)) {
  if (typeof declaration.describe !== 'string' || !declaration.describe) throw new Error(`${name}: no description`)
  for (const [param, spec] of Object.entries(declaration.params)) {
    if (!TYPE_PATTERN.test(spec)) throw new Error(`${name}: bad type for ${param}: ${spec}`)
    if (typeof declaration.about[param] !== 'string') throw new Error(`${name}: ${param} is not described`)
  }
  for (const param of Object.keys(declaration.about)) {
    if (!(param in declaration.params)) throw new Error(`${name}: ${param} is described but not declared`)
  }
  for (const [param, words] of Object.entries(declaration.misuse ?? {})) {
    if (typeof words !== 'string' || !words) throw new Error(`${name}: misuse of ${param} has no words`)
  }
}

/**
 * Check a call's params against the method's declaration. Throws
 * ValidationError naming the first offending param in `details.param`.
 */
export function validateParams (name, params) {
  const declaration = METHOD_DECLARATIONS[name]
  if (!declaration) throw new Error(`no such method: ${name}`)
  if (params === undefined) return
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ValidationError('params must be an object', {})
  }
  for (const [param, words] of Object.entries(declaration.misuse ?? {})) {
    const given = params[param] !== undefined && params[param] !== null
    const declared = param in declaration.params
    if (declared ? !given : given) {
      throw new ValidationError(`${name} ${declared ? 'needs' : 'does not take'} ${param}: ${words}`, { param })
    }
  }
  for (const [param, spec] of Object.entries(declaration.params)) {
    const [, type, optional] = TYPE_PATTERN.exec(spec)
    const value = params[param]
    if (value === undefined || value === null) {
      if (!optional) throw new ValidationError(`${param} is required`, { param })
      continue
    }
    if (!isOfType(value, type)) {
      throw new ValidationError(`${param} must be ${article(type)} ${type}`, { param })
    }
  }
}

function isOfType (value, type) {
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}

function article (type) {
  return type === 'object' ? 'an' : 'a'
}
