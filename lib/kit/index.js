/**
 * code-kit — the code domain core.
 *
 * Owns SQL, schema, transactions, trees, files, changes, guards,
 * historical reads, the import map and checks. Does not own HTTP,
 * auth, orgs, people, or the database connection lifecycle.
 *
 * A tree is a set of files. Every write is one change to it: a change
 * records, for each path it touched, the contents it left (by SHA-256,
 * stored once in code_blobs) or that it removed the file. The tree as
 * it is now is kept in code_files; any earlier state is read back from
 * the revisions.
 */

import { createHash, randomUUID } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { migrate as applyMigrations } from './schema.js'
import {
  ValidationError,
  NotFoundError,
  AlreadyExistsError,
  RevisionConflictError,
  EditMismatchError,
  PathConflictError,
  InvalidMoveError,
  LimitError
} from './errors.js'
import { assertTreeName, parseFilePath, basename, dirname, isWithin } from './paths.js'
import { analyze, findProblems, ready } from './check.js'
import {
  IMPORT_MAP_PATH,
  createRegistryResolver,
  formatImportMap,
  parsePackageSpec,
  pinnedPackages,
  readImportMap,
  withPin,
  withoutPin
} from './imports.js'
import { STARTERS } from './starters.js'

export * from './errors.js'
export * from './paths.js'
export { IMPORT_MAP_PATH, createRegistryResolver, parsePackageSpec, lookupImport } from './imports.js'
export { analyze, findProblems } from './check.js'
export { STARTERS } from './starters.js'

// How large one file may be, and how many files a tree may hold. Step
// 1 keeps every file in SQLite; large binaries move to object storage
// before anyone relies on them.
const MAX_FILE_BYTES = 1024 * 1024
const MAX_TREE_FILES = 1000

// A file's revisions: how many a history read returns unless asked,
// and at most.
const HISTORY_LIMIT = 50
const HISTORY_MAX = 500

// A tree's changes: how many a read returns unless asked, and at most.
const CHANGES_LIMIT = 50
const CHANGES_MAX = 500

// grep: matches returned unless asked, and at most; lines of context
// at most; how much of a line a regex is tried on (a long minified
// line would otherwise let one pattern run away); and how much of a
// matching line comes back.
const GREP_LIMIT = 200
const GREP_MAX = 2000
const GREP_CONTEXT_MAX = 10
const GREP_LINE_CHARS = 2000
const GREP_TEXT_CHARS = 400

// Analyses kept in memory, by extension and content hash.
const ANALYSIS_CACHE_SIZE = 2000

// Lines of context around each hunk of a change's patches.
const PATCH_CONTEXT = 3

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const utf8 = new TextDecoder('utf-8', { fatal: true })

function now () {
  return new Date().toISOString()
}

function hashOf (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isBinary (bytes) {
  if (bytes.includes(0)) return true
  try {
    utf8.decode(bytes)
    return false
  } catch {
    return true
  }
}

function textOf (bytes) {
  return Buffer.from(bytes).toString('utf8')
}

function assertActor (actor) {
  if (!actor || typeof actor !== 'object' ||
      typeof actor.type !== 'string' || actor.type === '' ||
      typeof actor.id !== 'string' || actor.id === '') {
    throw new ValidationError('actor with type and id is required', { actor })
  }
}

function assertOptionalText (value, name) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new ValidationError(`${name} must be a string or null`, { [name]: value })
  }
}

function assertMessage (message) {
  assertOptionalText(message, 'message')
}

function positiveInteger (value, name, { fallback, max } = {}) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    throw new ValidationError(max === undefined
      ? `${name} must be a positive integer`
      : `${name} must be an integer between 1 and ${max}`, { [name]: value })
  }
  return value
}

// What a write carries: text as `content`, or any bytes as `base64`.
function bytesOf ({ content, base64 }) {
  if (content !== undefined && content !== null && base64 !== undefined && base64 !== null) {
    throw new ValidationError('give content or base64, not both', {})
  }
  let bytes
  if (typeof content === 'string') {
    bytes = Buffer.from(content, 'utf8')
  } else if (typeof base64 === 'string') {
    const compact = base64.replace(/\s+/g, '')
    if (!BASE64.test(compact)) throw new ValidationError('base64 is not valid base64', {})
    bytes = Buffer.from(compact, 'base64')
  } else if (content !== undefined && content !== null) {
    throw new ValidationError('content must be a string', {})
  } else {
    throw new ValidationError('content is required (or base64, for a binary file)', {})
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new LimitError(`a file must be ${MAX_FILE_BYTES} bytes or smaller`, { size: bytes.length })
  }
  return bytes
}

function countOccurrences (text, search) {
  let count = 0
  let at = text.indexOf(search)
  while (at !== -1) {
    count++
    at = text.indexOf(search, at + search.length)
  }
  return count
}

// The folders above a path, nearest first: `a/b/c.js` → `a/b`, `a`.
function ancestorsOf (path) {
  const out = []
  for (let dir = dirname(path); dir !== ''; dir = dirname(dir)) out.push(dir)
  return out
}

// Paths strictly inside a folder sort between `<dir>/` and `<dir>0`
// ('0' follows '/'), so a range finds them on the primary key.
function folderRange (dir) {
  return [`${dir}/`, `${dir}0`]
}

function changeActor (row) {
  return {
    type: row.actor_type,
    id: row.actor_id,
    onBehalfOf: row.on_behalf_of ?? null,
    ...(row.actor_org ? { org: row.actor_org } : {}),
    ...(row.via ? { via: row.via } : {})
  }
}

function rowToChange (row) {
  return {
    id: row.id,
    treeId: row.tree_id,
    actor: changeActor(row),
    message: row.message,
    createdAt: row.created_at
  }
}

function rowToTree (row) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    files: row.files,
    changeId: row.change_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// What a revision did to its path: a removal, a move here, the first
// contents the path has had (or has had since a removal), or new ones.
function revisionAction (row) {
  if (row.hash === null) return 'deleted'
  if (row.moved_from) return 'moved'
  if (row.prev_count === 0 || row.prev_hash === null) return 'created'
  return 'updated'
}

function rowToRevision (row) {
  return {
    revisionId: row.id,
    changeId: row.change_id,
    path: row.path,
    action: revisionAction(row),
    ...(row.moved_from ? { from: row.moved_from } : {}),
    hash: row.hash,
    size: row.size ?? null,
    binary: row.binary === null || row.binary === undefined ? null : row.binary === 1,
    change: {
      id: row.change_id,
      message: row.message,
      actor: changeActor(row),
      createdAt: row.change_created_at
    }
  }
}

const TREE_SELECT = `
  SELECT t.*,
         (SELECT COUNT(*) FROM code_files f WHERE f.tree_id = t.id) AS files,
         (SELECT MAX(c.id) FROM code_changes c WHERE c.tree_id = t.id) AS change_id
  FROM code_trees t
`

// A revision with its change and blob, and what the path held before
// it, so a revision says what it did and who did it.
const REVISION_SELECT = `
  SELECT r.id, r.tree_id, r.change_id, r.path, r.hash, r.moved_from, r.created_at,
         c.actor_type, c.actor_id, c.on_behalf_of, c.actor_org, c.via, c.message,
         c.created_at AS change_created_at,
         b.size, b.binary,
         (SELECT p.hash FROM code_revisions p
            WHERE p.tree_id = r.tree_id AND p.path = r.path AND p.change_id < r.change_id
            ORDER BY p.change_id DESC LIMIT 1) AS prev_hash,
         (SELECT COUNT(*) FROM code_revisions p
            WHERE p.tree_id = r.tree_id AND p.path = r.path AND p.change_id < r.change_id) AS prev_count
  FROM code_revisions r
  JOIN code_changes c ON c.id = r.change_id
  LEFT JOIN code_blobs b ON b.hash = r.hash
`

/**
 * @param {{ db: import('better-sqlite3').Database,
 *           resolvePackage?: (name: string, wanted?: string) => Promise<{ name: string, version: string, url: string }> }} options
 *   `resolvePackage` says which exact version a package name (and an
 *   optional version, range or tag) means, and where it is served;
 *   the default asks the npm registry and pins on esm.sh.
 */
export function createCodeKit ({ db, resolvePackage = createRegistryResolver() }) {
  if (!db) throw new ValidationError('db is required', {})

  const statements = new Map()
  function stmt (sql) {
    let statement = statements.get(sql)
    if (!statement) {
      statement = db.prepare(sql)
      statements.set(sql, statement)
    }
    return statement
  }

  /* ------------------------------------------------------------------ *
   * reads
   * ------------------------------------------------------------------ */

  function treeRow (treeId) {
    const row = stmt(`${TREE_SELECT} WHERE t.id = ? AND t.deleted = 0`).get(treeId)
    if (!row) throw new NotFoundError('tree not found', { treeId })
    return row
  }

  function latestChangeId (treeId) {
    return stmt('SELECT MAX(id) AS id FROM code_changes WHERE tree_id = ?').get(treeId).id ?? null
  }

  function blob (hash) {
    return stmt('SELECT content FROM code_blobs WHERE hash = ?').get(hash).content
  }

  // A change of this tree, checked; null when none was asked for.
  function resolveChange (treeId, changeId) {
    if (changeId === undefined || changeId === null) return null
    positiveInteger(changeId, 'changeId')
    const row = stmt('SELECT id FROM code_changes WHERE id = ? AND tree_id = ?').get(changeId, treeId)
    if (!row) throw new NotFoundError(`no change ${changeId} in this tree`, { changeId })
    return changeId
  }

  // The tree's files now, or as they stood after a change, in path
  // order, each with its size and whether it is binary.
  function filesAt (treeId, changeId) {
    if (changeId === null) {
      return stmt(`
        SELECT f.path, f.hash, f.revision_id, f.change_id, b.size, b.binary
        FROM code_files f JOIN code_blobs b ON b.hash = f.hash
        WHERE f.tree_id = ? ORDER BY f.path
      `).all(treeId)
    }
    return stmt(`
      SELECT r.path, r.hash, r.id AS revision_id, r.change_id, b.size, b.binary
      FROM code_revisions r JOIN code_blobs b ON b.hash = r.hash
      WHERE r.tree_id = ? AND r.change_id <= ? AND r.change_id = (
        SELECT MAX(p.change_id) FROM code_revisions p
        WHERE p.tree_id = r.tree_id AND p.path = r.path AND p.change_id <= ?)
      ORDER BY r.path
    `).all(treeId, changeId, changeId)
  }

  // One file now, or as it stood after a change; undefined when absent.
  function fileAt (treeId, path, changeId) {
    if (changeId === null) {
      return stmt(`
        SELECT f.path, f.hash, f.revision_id, f.change_id, b.size, b.binary
        FROM code_files f JOIN code_blobs b ON b.hash = f.hash
        WHERE f.tree_id = ? AND f.path = ?
      `).get(treeId, path)
    }
    const row = stmt(`
      SELECT r.path, r.hash, r.id AS revision_id, r.change_id
      FROM code_revisions r
      WHERE r.tree_id = ? AND r.path = ? AND r.change_id <= ?
      ORDER BY r.change_id DESC LIMIT 1
    `).get(treeId, path, changeId)
    if (!row || row.hash === null) return undefined
    const meta = stmt('SELECT size, binary FROM code_blobs WHERE hash = ?').get(row.hash)
    return { ...row, ...meta }
  }

  function filesUnderNow (treeId, dir) {
    if (dir === '') return filesAt(treeId, null)
    const [from, to] = folderRange(dir)
    return stmt(`
      SELECT f.path, f.hash, f.revision_id, f.change_id, b.size, b.binary
      FROM code_files f JOIN code_blobs b ON b.hash = f.hash
      WHERE f.tree_id = ? AND f.path >= ? AND f.path < ? ORDER BY f.path
    `).all(treeId, from, to)
  }

  function isFolderNow (treeId, dir) {
    if (dir === '') return true
    const [from, to] = folderRange(dir)
    return Boolean(stmt('SELECT 1 FROM code_files WHERE tree_id = ? AND path >= ? AND path < ? LIMIT 1').get(treeId, from, to))
  }

  // A file that must exist now, read for a change to it: a folder or a
  // missing path is refused saying which.
  function requireFileNow (treeId, path) {
    const file = fileAt(treeId, path, null)
    if (file) return file
    if (isFolderNow(treeId, path)) throw new ValidationError(`${path} is a folder; list it with code.tree`, { path })
    throw new NotFoundError(`no file ${path}`, { path })
  }

  const analyses = new Map()

  // A file's analysis, cached by extension and contents: the same
  // contents under the same kind of name always analyze alike.
  function analysisOf (path, hash, binary) {
    if (binary) return null
    const key = `${path.slice(path.lastIndexOf('.'))}\0${hash}`
    let analysis = analyses.get(key)
    if (analysis) {
      analyses.delete(key)
    } else {
      analysis = analyze(path, textOf(blob(hash)))
      if (analyses.size >= ANALYSIS_CACHE_SIZE) analyses.delete(analyses.keys().next().value)
    }
    analyses.set(key, analysis)
    return analysis
  }

  function problemsAt (treeId, changeId) {
    const files = filesAt(treeId, changeId)
    const map = files.find((file) => file.path === IMPORT_MAP_PATH)
    return findProblems({
      files: files.map((file) => ({ path: file.path, analysis: analysisOf(file.path, file.hash, file.binary === 1) })),
      importMap: map && map.binary === 0 ? textOf(blob(map.hash)) : null
    })
  }

  function revisionsOfChange (changeId) {
    const rows = stmt(`${REVISION_SELECT} WHERE r.change_id = ? ORDER BY r.path`).all(changeId)
    // A move is a removal at the old path and a revision at the new
    // one; the change lists it once, as the move.
    const movedAway = new Set(rows.filter((row) => row.moved_from).map((row) => row.moved_from))
    return rows.filter((row) => !(row.hash === null && movedAway.has(row.path)))
  }

  function changeFiles (changeId) {
    return revisionsOfChange(changeId).map((row) => ({
      path: row.path,
      action: revisionAction(row),
      ...(row.moved_from ? { from: row.moved_from } : {}),
      revisionId: row.id
    }))
  }

  // What a path held just before a revision: its own previous
  // contents, or — for a move — what the old path held.
  function previousOf (row) {
    return stmt(`${REVISION_SELECT}
      WHERE r.tree_id = ? AND r.path = ? AND r.change_id < ?
      ORDER BY r.change_id DESC LIMIT 1
    `).get(row.tree_id, row.moved_from ?? row.path, row.change_id) ?? null
  }

  function withContents (revision) {
    if (revision.hash === null) return { ...revision, content: null }
    const bytes = blob(revision.hash)
    return revision.binary
      ? { ...revision, base64: Buffer.from(bytes).toString('base64') }
      : { ...revision, content: textOf(bytes) }
  }

  /* ------------------------------------------------------------------ *
   * writes
   * ------------------------------------------------------------------ */

  function checkRevision (file, ifRevision, path) {
    if (ifRevision === undefined || ifRevision === null) return
    if (typeof ifRevision !== 'string' || ifRevision === '') {
      throw new ValidationError('ifRevision must be a non-empty string', {})
    }
    if (!file) {
      throw new RevisionConflictError(`${path} is not there any more`, { path, ifRevision, actualRevisionId: null })
    }
    if (file.revision_id !== ifRevision) {
      throw new RevisionConflictError(`${path} has changed since it was read`, {
        path, ifRevision, actualRevisionId: file.revision_id
      })
    }
  }

  function checkChange (treeId, ifChange) {
    if (ifChange === undefined || ifChange === null) return
    positiveInteger(ifChange, 'ifChange')
    const actual = latestChangeId(treeId)
    if (actual !== ifChange) {
      throw new RevisionConflictError(`the tree has changed since change ${ifChange}`, { ifChange, actualChangeId: actual })
    }
  }

  // A file may be written at `path` only where no folder is, and no
  // folder above it is a file.
  function checkPlace (treeId, path, { leaving = new Set() } = {}) {
    if (isFolderNow(treeId, path)) {
      throw new PathConflictError(`${path} is a folder`, { path })
    }
    for (const dir of ancestorsOf(path)) {
      if (!leaving.has(dir) && fileAt(treeId, dir, null)) {
        throw new PathConflictError(`${dir} is a file, so ${path} cannot be inside it`, { path, file: dir })
      }
    }
  }

  // Apply one change inside the caller's transaction. Each op leaves
  // contents at a path (`bytes`, or an existing blob's `hash`) or
  // removes the file (neither). Ops that leave a path as it is are
  // dropped; a change with none left is not made, and null comes back.
  function applyChange ({ treeId, actor, message, ops }) {
    const effective = []
    let created = 0
    let removed = 0
    for (const op of ops) {
      const hash = op.bytes ? hashOf(op.bytes) : op.hash ?? null
      const current = stmt('SELECT hash FROM code_files WHERE tree_id = ? AND path = ?').get(treeId, op.path)
      if ((current?.hash ?? null) === hash) continue
      if (!current) created++
      if (hash === null) removed++
      effective.push({ ...op, hash })
    }
    if (effective.length === 0) return null
    const count = stmt('SELECT COUNT(*) AS n FROM code_files WHERE tree_id = ?').get(treeId).n
    if (count + created - removed > MAX_TREE_FILES) {
      throw new LimitError(`a tree holds at most ${MAX_TREE_FILES} files`, { files: count })
    }
    const timestamp = now()
    const changeId = Number(stmt(`
      INSERT INTO code_changes (tree_id, actor_type, actor_id, on_behalf_of, actor_org, via, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      treeId, actor.type, actor.id, actor.onBehalfOf ?? null, actor.org ?? null, actor.via ?? null, message ?? null, timestamp
    ).lastInsertRowid)
    for (const op of effective) {
      if (op.bytes) {
        stmt('INSERT OR IGNORE INTO code_blobs (hash, size, binary, content) VALUES (?, ?, ?, ?)')
          .run(op.hash, op.bytes.length, isBinary(op.bytes) ? 1 : 0, op.bytes)
      }
      const revisionId = randomUUID()
      stmt(`
        INSERT INTO code_revisions (id, tree_id, change_id, path, hash, moved_from, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(revisionId, treeId, changeId, op.path, op.hash, op.movedFrom ?? null, timestamp)
      if (op.hash) {
        stmt(`
          INSERT INTO code_files (tree_id, path, hash, revision_id, change_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (tree_id, path) DO UPDATE SET
            hash = excluded.hash, revision_id = excluded.revision_id,
            change_id = excluded.change_id, updated_at = excluded.updated_at
        `).run(treeId, op.path, op.hash, revisionId, changeId, timestamp)
      } else {
        stmt('DELETE FROM code_files WHERE tree_id = ? AND path = ?').run(treeId, op.path)
      }
    }
    stmt('UPDATE code_trees SET updated_at = ? WHERE id = ?').run(timestamp, treeId)
    return changeId
  }

  // One change, planned and applied in a single write transaction, so
  // the guards a plan checks still hold when its ops land.
  function change ({ treeId, actor, message, plan }) {
    return db.transaction(() => {
      treeRow(treeId)
      const planned = plan()
      return { ...planned, changeId: applyChange({ treeId, actor, message, ops: planned.ops }) }
    }).immediate()
  }

  function written (treeId, path, changeId, extra = {}) {
    const file = fileAt(treeId, path, null)
    return {
      path,
      changeId,
      changed: changeId !== null,
      revisionId: file?.revision_id ?? null,
      ...extra,
      problems: problemsAt(treeId, null)
    }
  }

  return {
    async migrate () {
      applyMigrations(db)
      await ready()
    },

    /* Trees ------------------------------------------------------------ */

    async listTrees () {
      return stmt(`${TREE_SELECT} WHERE t.deleted = 0 ORDER BY t.name`).all().map(rowToTree)
    },

    /** The tree with this name, or null. */
    async findTree ({ name }) {
      const row = stmt(`${TREE_SELECT} WHERE t.name = ? AND t.deleted = 0`).get(name)
      return row ? rowToTree(row) : null
    },

    async getTree ({ treeId }) {
      return rowToTree(treeRow(treeId))
    },

    /**
     * Create a tree, empty or from a starter (whose files are its
     * first change).
     */
    async createTree ({ name, title, description, starter, actor, message }) {
      await ready()
      assertTreeName(name)
      assertOptionalText(title, 'title')
      assertOptionalText(description, 'description')
      assertMessage(message)
      assertActor(actor)
      if (starter !== undefined && starter !== null && !Object.hasOwn(STARTERS, starter)) {
        throw new ValidationError(`no starter named ${starter}; the starters are ${Object.keys(STARTERS).join(', ')}`, { starter })
      }
      const id = randomUUID()
      const changeId = db.transaction(() => {
        if (stmt('SELECT 1 FROM code_trees WHERE name = ? AND deleted = 0').get(name)) {
          throw new AlreadyExistsError(`a tree named ${name} already exists`, { name })
        }
        const timestamp = now()
        stmt(`
          INSERT INTO code_trees (id, name, title, description, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, name, title ?? null, description ?? null, timestamp, timestamp)
        if (!starter) return null
        const ops = Object.entries(STARTERS[starter].files)
          .map(([path, content]) => ({ path, bytes: Buffer.from(content, 'utf8') }))
        return applyChange({ treeId: id, actor, message: message ?? `start from the ${starter} starter`, ops })
      }).immediate()
      return { tree: rowToTree(treeRow(id)), changeId, problems: problemsAt(id, null) }
    },

    /** Change what a tree says about itself: its title and description. */
    async updateTree ({ treeId, title, description }) {
      assertOptionalText(title, 'title')
      assertOptionalText(description, 'description')
      if (title === undefined && description === undefined) {
        throw new ValidationError('give a title or a description to change', {})
      }
      db.transaction(() => {
        const row = treeRow(treeId)
        stmt('UPDATE code_trees SET title = ?, description = ?, updated_at = ? WHERE id = ?').run(
          title === undefined ? row.title : title,
          description === undefined ? row.description : description,
          now(),
          treeId
        )
      }).immediate()
      return rowToTree(treeRow(treeId))
    },

    /* Files ------------------------------------------------------------ */

    /**
     * The files and folders under a path, now or as of a change. Folders
     * come first; a folder past `depth` comes without its children.
     */
    async listFiles ({ treeId, path = '', depth, changeId }) {
      treeRow(treeId)
      const dir = parseFilePath(path)
      const maxDepth = positiveInteger(depth, 'depth', { fallback: Infinity })
      const at = resolveChange(treeId, changeId)
      const files = filesAt(treeId, at)
      if (dir !== '' && files.some((file) => file.path === dir)) {
        throw new ValidationError(`${dir} is a file; read it with code.read`, { path: dir })
      }
      const under = files.filter((file) => file.path !== dir && isWithin(file.path, dir))
      if (dir !== '' && under.length === 0) throw new NotFoundError(`no folder ${dir}`, { path: dir })
      const root = { type: 'folder', path: dir, name: basename(dir), files: 0, children: [] }
      // A folder at level `depth` (the path's children are level 1)
      // comes without children; the files beneath it still count.
      for (const file of under) {
        root.files++
        const segments = (dir === '' ? file.path : file.path.slice(dir.length + 1)).split('/')
        let folder = root
        for (let i = 0; i < segments.length - 1 && folder.children; i++) {
          let next = folder.children.find((child) => child.type === 'folder' && child.name === segments[i])
          if (!next) {
            const folderPath = folder.path === '' ? segments[i] : `${folder.path}/${segments[i]}`
            next = { type: 'folder', path: folderPath, name: segments[i], files: 0, ...(i + 1 < maxDepth ? { children: [] } : {}) }
            folder.children.push(next)
          }
          next.files++
          folder = next
        }
        if (folder.children && folder.path === dirname(file.path)) {
          folder.children.push({
            type: 'file',
            path: file.path,
            name: basename(file.path),
            size: file.size,
            binary: file.binary === 1,
            revisionId: file.revision_id,
            changeId: file.change_id
          })
        }
      }
      const order = (node) => {
        if (!node.children) return
        node.children.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name < b.name ? -1 : 1))
        node.children.forEach(order)
      }
      order(root)
      return { changeId: at ?? latestChangeId(treeId), ...root }
    },

    /**
     * Read one file, now or as of a change. Text comes as `content`
     * (a range of lines with offset and limit), a binary file as
     * `base64`.
     */
    async readFile ({ treeId, path, offset, limit, changeId }) {
      treeRow(treeId)
      const filePath = parseFilePath(path)
      if (filePath === '') throw new ValidationError('a tree\'s root is a folder; list it with code.tree', {})
      const at = resolveChange(treeId, changeId)
      const first = positiveInteger(offset, 'offset', { fallback: 1 })
      const count = positiveInteger(limit, 'limit', { fallback: Infinity })
      const file = fileAt(treeId, filePath, at)
      if (!file) {
        const folder = filesAt(treeId, at).some((other) => isWithin(other.path, filePath) && other.path !== filePath)
        if (folder) throw new ValidationError(`${filePath} is a folder; list it with code.tree`, { path: filePath })
        throw new NotFoundError(`no file ${filePath}`, { path: filePath })
      }
      const about = {
        path: filePath,
        size: file.size,
        hash: file.hash,
        revisionId: file.revision_id,
        changeId: file.change_id
      }
      const bytes = blob(file.hash)
      if (file.binary === 1) return { ...about, binary: true, base64: Buffer.from(bytes).toString('base64') }
      const text = textOf(bytes)
      const lines = text.split('\n')
      const total = text.endsWith('\n') ? lines.length - 1 : lines.length
      if (offset === undefined && limit === undefined) {
        return { ...about, binary: false, lines: total, content: text }
      }
      const slice = lines.slice(first - 1, count === Infinity ? undefined : first - 1 + count)
      const end = first - 1 + slice.length
      const content = slice.join('\n') + (end < lines.length && slice.length > 0 ? '\n' : '')
      return { ...about, binary: false, lines: total, offset: first, content }
    },

    /** Write a file whole: create it or replace its contents. */
    async writeFile ({ treeId, path, content, base64, ifRevision, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      const filePath = parseFilePath(path)
      if (filePath === '') throw new ValidationError('write a file, not the tree\'s root: <tree>:<path>', {})
      const bytes = bytesOf({ content, base64 })
      const { created, changeId } = change({
        treeId,
        actor,
        message,
        plan: () => {
          const current = fileAt(treeId, filePath, null)
          checkRevision(current, ifRevision, filePath)
          if (!current) checkPlace(treeId, filePath)
          return { created: !current, ops: [{ path: filePath, bytes }] }
        }
      })
      return written(treeId, filePath, changeId, { created })
    },

    /**
     * Change part of a text file: replace one exact string. Refused
     * unless it occurs exactly once, or replaceAll is given.
     */
    async editFile ({ treeId, path, oldString, newString, replaceAll, ifRevision, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      const filePath = parseFilePath(path)
      if (typeof oldString !== 'string' || oldString === '') {
        throw new ValidationError('oldString must be a non-empty string', {})
      }
      if (typeof newString !== 'string') throw new ValidationError('newString must be a string', {})
      if (oldString === newString) throw new ValidationError('oldString and newString are the same', {})
      const { replaced, changeId } = change({
        treeId,
        actor,
        message,
        plan: () => {
          const current = requireFileNow(treeId, filePath)
          checkRevision(current, ifRevision, filePath)
          if (current.binary === 1) {
            throw new ValidationError(`${filePath} is binary; write it whole with code.write`, { path: filePath })
          }
          const text = textOf(blob(current.hash))
          const occurrences = countOccurrences(text, oldString)
          if (occurrences === 0) {
            throw new EditMismatchError(`oldString does not occur in ${filePath}; read the file again and copy the text exactly`, { path: filePath, occurrences })
          }
          if (occurrences > 1 && replaceAll !== true) {
            throw new EditMismatchError(`oldString occurs ${occurrences} times in ${filePath}; include more of the surrounding text so it occurs once, or give replaceAll`, { path: filePath, occurrences })
          }
          const next = replaceAll === true
            ? text.split(oldString).join(newString)
            : text.slice(0, text.indexOf(oldString)) + newString + text.slice(text.indexOf(oldString) + oldString.length)
          const bytes = Buffer.from(next, 'utf8')
          if (bytes.length > MAX_FILE_BYTES) {
            throw new LimitError(`a file must be ${MAX_FILE_BYTES} bytes or smaller`, { size: bytes.length })
          }
          return { replaced: replaceAll === true ? occurrences : 1, ops: [{ path: filePath, bytes }] }
        }
      })
      return written(treeId, filePath, changeId, { created: false, replaced })
    },

    /** Move or rename a file, or a folder and everything in it. */
    async moveFile ({ treeId, from, to, ifRevision, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      const fromPath = parseFilePath(from)
      const toPath = parseFilePath(to)
      if (fromPath === '' || toPath === '') throw new InvalidMoveError('a tree\'s root does not move', { from, to })
      if (fromPath === toPath) throw new InvalidMoveError('from and to are the same', { from, to })
      if (isWithin(toPath, fromPath)) throw new InvalidMoveError('a folder cannot move inside itself', { from, to })
      const { moved, changeId } = change({
        treeId,
        actor,
        message,
        plan: () => {
          const file = fileAt(treeId, fromPath, null)
          const sources = file ? [file] : filesUnderNow(treeId, fromPath)
          if (sources.length === 0) throw new NotFoundError(`nothing at ${fromPath}`, { path: fromPath })
          if (file) {
            checkRevision(file, ifRevision, fromPath)
          } else if (ifRevision !== undefined && ifRevision !== null) {
            throw new ValidationError('ifRevision guards one file; moving a folder takes none', {})
          }
          if (fileAt(treeId, toPath, null) || isFolderNow(treeId, toPath)) {
            throw new AlreadyExistsError(`${toPath} already exists`, { path: toPath })
          }
          checkPlace(treeId, toPath, { leaving: new Set([fromPath]) })
          const pairs = sources.map((source) => ({
            from: source.path,
            to: file ? toPath : toPath + source.path.slice(fromPath.length),
            hash: source.hash
          }))
          return {
            moved: pairs.map(({ from: a, to: b }) => ({ from: a, to: b })),
            ops: pairs.flatMap((pair) => [
              { path: pair.from },
              { path: pair.to, hash: pair.hash, movedFrom: pair.from }
            ])
          }
        }
      })
      return { from: fromPath, to: toPath, changeId, moved, problems: problemsAt(treeId, null) }
    },

    /** Remove a file, or (recursive) a folder and everything in it. */
    async removeFile ({ treeId, path, recursive, ifRevision, ifChange, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      const filePath = parseFilePath(path)
      if (filePath === '') {
        throw new ValidationError('a tree\'s root is not removed, and trees are not removed through the API; remove a file or a folder', {})
      }
      const { removed, changeId } = change({
        treeId,
        actor,
        message,
        plan: () => {
          checkChange(treeId, ifChange)
          const file = fileAt(treeId, filePath, null)
          if (file) {
            checkRevision(file, ifRevision, filePath)
            return { removed: [filePath], ops: [{ path: filePath }] }
          }
          const files = filesUnderNow(treeId, filePath)
          if (files.length === 0) throw new NotFoundError(`nothing at ${filePath}`, { path: filePath })
          if (ifRevision !== undefined && ifRevision !== null) {
            throw new ValidationError('ifRevision guards one file; for a folder, guard with ifChange', {})
          }
          if (recursive !== true) {
            throw new ValidationError(`${filePath} is a folder with ${files.length} file${files.length === 1 ? '' : 's'}; give recursive to remove it and everything in it`, { path: filePath, files: files.length })
          }
          return { removed: files.map((each) => each.path), ops: files.map((each) => ({ path: each.path })) }
        }
      })
      return { path: filePath, changeId, removed, problems: problemsAt(treeId, null) }
    },

    /**
     * Matching lines under a path, as path and line number: a literal
     * string unless `regex`, with lines of context on request.
     */
    async grep ({ treeId, path = '', pattern, regex, ignoreCase, context, limit }) {
      treeRow(treeId)
      const dir = parseFilePath(path)
      if (typeof pattern !== 'string' || pattern === '') throw new ValidationError('pattern must be a non-empty string', {})
      const max = positiveInteger(limit, 'limit', { fallback: GREP_LIMIT, max: GREP_MAX })
      const around = context === undefined || context === null
        ? 0
        : context === 0 ? 0 : positiveInteger(context, 'context', { max: GREP_CONTEXT_MAX })
      let test
      if (regex === true) {
        let expression
        try {
          expression = new RegExp(pattern, ignoreCase === true ? 'i' : '')
        } catch (error) {
          throw new ValidationError(`not a valid regex: ${error.message}`, { pattern })
        }
        test = (line) => expression.test(line.slice(0, GREP_LINE_CHARS))
      } else if (ignoreCase === true) {
        const needle = pattern.toLowerCase()
        test = (line) => line.toLowerCase().includes(needle)
      } else {
        test = (line) => line.includes(pattern)
      }
      const files = filesAt(treeId, null).filter((file) => isWithin(file.path, dir))
      if (dir !== '' && files.length === 0) throw new NotFoundError(`nothing at ${dir}`, { path: dir })
      const clip = (line) => (line.length > GREP_TEXT_CHARS ? `${line.slice(0, GREP_TEXT_CHARS)}…` : line)
      const matches = []
      let truncated = false
      let searched = 0
      for (const file of files) {
        if (file.binary === 1) continue
        searched++
        const lines = textOf(blob(file.hash)).split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!test(lines[i])) continue
          if (matches.length === max) {
            truncated = true
            break
          }
          matches.push({
            path: file.path,
            line: i + 1,
            text: clip(lines[i]),
            ...(around > 0
              ? { before: lines.slice(Math.max(0, i - around), i).map(clip), after: lines.slice(i + 1, i + 1 + around).map(clip) }
              : {})
          })
        }
        if (truncated) break
      }
      return { matches, truncated, files: searched }
    },

    /* Packages ---------------------------------------------------------- */

    /** The packages the tree's import map pins. */
    async deps ({ treeId }) {
      treeRow(treeId)
      const file = fileAt(treeId, IMPORT_MAP_PATH, null)
      const { map, problem } = readImportMap(file && file.binary === 0 ? textOf(blob(file.hash)) : null)
      return {
        path: IMPORT_MAP_PATH,
        packages: pinnedPackages(map),
        imports: map.imports,
        ...(problem ? { problem } : {})
      }
    },

    /**
     * Pin a package in the import map at an exact version: the latest,
     * or the one a version, range or tag means.
     */
    async pin ({ treeId, package: spec, version, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      treeRow(treeId)
      const wanted = parsePackageSpec(spec, version)
      const resolved = await resolvePackage(wanted.name, wanted.version)
      const { changeId } = change({
        treeId,
        actor,
        message: message ?? `pin ${resolved.name}@${resolved.version}`,
        plan: () => {
          const file = fileAt(treeId, IMPORT_MAP_PATH, null)
          const { map, problem } = readImportMap(file ? textOf(blob(file.hash)) : null)
          if (problem) throw new ValidationError(`fix imports.json first: ${problem}`, { path: IMPORT_MAP_PATH })
          if (!file) checkPlace(treeId, IMPORT_MAP_PATH)
          const bytes = Buffer.from(formatImportMap(withPin(map, resolved.name, resolved.url)), 'utf8')
          return { ops: [{ path: IMPORT_MAP_PATH, bytes }] }
        }
      })
      return {
        package: { name: resolved.name, version: resolved.version, url: resolved.url },
        ...written(treeId, IMPORT_MAP_PATH, changeId)
      }
    },

    /** Drop a package from the import map. */
    async unpin ({ treeId, package: spec, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      const { name, version } = parsePackageSpec(spec)
      if (version !== undefined) throw new ValidationError('unpin takes a package name alone', { package: spec })
      const { changeId } = change({
        treeId,
        actor,
        message: message ?? `unpin ${name}`,
        plan: () => {
          const file = fileAt(treeId, IMPORT_MAP_PATH, null)
          const { map, problem } = readImportMap(file ? textOf(blob(file.hash)) : null)
          if (problem) throw new ValidationError(`fix imports.json first: ${problem}`, { path: IMPORT_MAP_PATH })
          if (!Object.hasOwn(map.imports, name) && !Object.hasOwn(map.imports, `${name}/`)) {
            throw new NotFoundError(`${name} is not pinned`, { package: name })
          }
          const bytes = Buffer.from(formatImportMap(withoutPin(map, name)), 'utf8')
          return { ops: [{ path: IMPORT_MAP_PATH, bytes }] }
        }
      })
      return { package: { name }, ...written(treeId, IMPORT_MAP_PATH, changeId) }
    },

    /* History ----------------------------------------------------------- */

    /** One file's revisions, newest first, following it back through moves. */
    async fileHistory ({ treeId, path, limit }) {
      treeRow(treeId)
      const filePath = parseFilePath(path)
      if (filePath === '') {
        throw new ValidationError('history is of one file; a tree\'s history is code.changes', {})
      }
      const max = positiveInteger(limit, 'limit', { fallback: HISTORY_LIMIT, max: HISTORY_MAX })
      const out = []
      let current = filePath
      let before = Number.MAX_SAFE_INTEGER
      while (current !== null && out.length < max) {
        const rows = stmt(`${REVISION_SELECT}
          WHERE r.tree_id = ? AND r.path = ? AND r.change_id < ?
          ORDER BY r.change_id DESC LIMIT ?
        `).all(treeId, current, before, max - out.length)
        current = null
        for (const row of rows) {
          out.push(rowToRevision(row))
          if (row.moved_from) {
            current = row.moved_from
            before = row.change_id
            break
          }
        }
      }
      if (out.length === 0) {
        if (isFolderNow(treeId, filePath)) {
          throw new ValidationError(`${filePath} is a folder; its history is code.changes`, { path: filePath })
        }
        throw new NotFoundError(`${filePath} has no history`, { path: filePath })
      }
      return out
    },

    /** One revision with its contents, and the one before it, for a diff. */
    async getRevision ({ treeId, revisionId }) {
      treeRow(treeId)
      if (typeof revisionId !== 'string' || revisionId === '') {
        throw new ValidationError('revisionId must be a non-empty string', {})
      }
      const row = stmt(`${REVISION_SELECT} WHERE r.id = ? AND r.tree_id = ?`).get(revisionId, treeId)
      if (!row) throw new NotFoundError('revision not found', { revisionId })
      const previous = previousOf(row)
      return {
        ...withContents(rowToRevision(row)),
        previous: previous && previous.hash !== null ? withContents(rowToRevision(previous)) : null
      }
    },

    /** What changed across the tree (or under a path), newest first. */
    async getChanges ({ treeId, path = '', limit, before }) {
      treeRow(treeId)
      const dir = parseFilePath(path)
      const max = positiveInteger(limit, 'limit', { fallback: CHANGES_LIMIT, max: CHANGES_MAX })
      const until = positiveInteger(before, 'before', { fallback: Number.MAX_SAFE_INTEGER })
      const rows = dir === ''
        ? stmt('SELECT * FROM code_changes WHERE tree_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(treeId, until, max)
        : stmt(`
            SELECT c.* FROM code_changes c
            WHERE c.tree_id = ? AND c.id < ? AND EXISTS (
              SELECT 1 FROM code_revisions r
              WHERE r.change_id = c.id AND (r.path = ? OR (r.path >= ? AND r.path < ?)))
            ORDER BY c.id DESC LIMIT ?
          `).all(treeId, until, dir, ...folderRange(dir), max)
      return rows.map((row) => ({ ...rowToChange(row), files: changeFiles(row.id) }))
    },

    /** One change: who made it, and what it did to each file, as patches. */
    async getChange ({ treeId, changeId }) {
      treeRow(treeId)
      if (changeId === undefined || changeId === null) throw new ValidationError('changeId is required', {})
      resolveChange(treeId, changeId)
      const row = stmt('SELECT * FROM code_changes WHERE id = ?').get(changeId)
      const files = revisionsOfChange(changeId).map((revision) => {
        const previous = previousOf(revision)
        const before = previous && previous.hash !== null ? previous : null
        const binary = revision.binary === 1 || before?.binary === 1
        const patch = binary
          ? null
          : createTwoFilesPatch(
            before ? before.path : revision.path,
            revision.path,
            before ? textOf(blob(before.hash)) : '',
            revision.hash ? textOf(blob(revision.hash)) : '',
            undefined,
            undefined,
            { context: PATCH_CONTEXT }
          )
        return {
          path: revision.path,
          action: revisionAction(revision),
          ...(revision.moved_from ? { from: revision.moved_from } : {}),
          revisionId: revision.id,
          binary,
          patch
        }
      })
      return { ...rowToChange(row), files }
    },

    /**
     * Put a file, a folder, or the whole tree back as it stood after a
     * change, as a new change.
     */
    async restore ({ treeId, path = '', changeId, ifChange, actor, message }) {
      await ready()
      assertActor(actor)
      assertMessage(message)
      treeRow(treeId)
      const dir = parseFilePath(path)
      if (changeId === undefined || changeId === null) {
        throw new ValidationError('changeId is required: the change to restore to', {})
      }
      resolveChange(treeId, changeId)
      const { restored, removed, changeId: made } = change({
        treeId,
        actor,
        message: message ?? `restore ${dir === '' ? 'the tree' : dir} to change ${changeId}`,
        plan: () => {
          checkChange(treeId, ifChange)
          const then = filesAt(treeId, changeId).filter((file) => isWithin(file.path, dir))
          const current = filesAt(treeId, null).filter((file) => isWithin(file.path, dir))
          if (dir !== '' && then.length === 0 && current.length === 0) {
            throw new NotFoundError(`nothing at ${dir}, then or now`, { path: dir })
          }
          const thenByPath = new Map(then.map((file) => [file.path, file]))
          const nowByPath = new Map(current.map((file) => [file.path, file]))
          const leaving = new Set(current.filter((file) => !thenByPath.has(file.path)).map((file) => file.path))
          const writes = then.filter((file) => nowByPath.get(file.path)?.hash !== file.hash)
          for (const file of writes) {
            if (!nowByPath.has(file.path)) checkPlace(treeId, file.path, { leaving })
          }
          return {
            restored: writes.map((file) => file.path),
            removed: [...leaving],
            ops: [
              ...[...leaving].map((each) => ({ path: each })),
              ...writes.map((file) => ({ path: file.path, hash: file.hash }))
            ]
          }
        }
      })
      return { path: dir, changeId: made, changed: made !== null, restored, removed, problems: problemsAt(treeId, null) }
    },

    /* Check -------------------------------------------------------------- */

    /** Every problem in the tree, now or as of a change. */
    async check ({ treeId, changeId }) {
      await ready()
      treeRow(treeId)
      const at = resolveChange(treeId, changeId)
      return {
        changeId: at ?? latestChangeId(treeId),
        files: filesAt(treeId, at).length,
        problems: problemsAt(treeId, at)
      }
    }
  }
}
