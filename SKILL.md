---
name: code
description: Build and change a site whose source is a code tree held in Known, through the code.* methods, with no filesystem, no git and no bundler. Use when a task means reading or writing a tree's files, addressed like hello:src/app.js.
---

# Working with a code tree

A code tree is a site's source held in Known: files with history, read and
written over the API. There is no filesystem, no shell, no package manager
and no build. Browsers run the files as they are: HTML, CSS and ES modules,
with packages from esm.sh pinned in the tree's import map.

Files are addressed `<tree>:<path>`, with slashes inside the tree:

```text
hello:                the tree's root
hello:index.html      a file
hello:src/app.js      a file in a folder
```

Folders are implied by the paths in them; there are no empty folders.

## The methods

| | |
|---|---|
| **orient** | `code.list` (trees), `code.tree` (files and folders), `code.grep` (matching lines) |
| **read** | `code.read` (a file, or a range of lines with `offset` and `limit`) |
| **write** | `code.write` (a whole file), `code.edit` (one exact string for another) |
| **reorganize** | `code.move`, `code.remove` |
| **packages** | `code.deps`, `code.pin`, `code.unpin` |
| **history** | `code.changes` (the tree's), `code.history` (a file's), `code.getChange`, `code.getRevision`, `code.restore` |
| **check** | `code.check` |

The verbs are the wiki's: files are read, written, edited, moved and removed
like pages, and a tree's history is its changes.

## Core rules

1. **Orient first.** `code.tree` the tree, and `code.grep` for what you
   are about to change, before writing.
2. **Change only what you mean to.** Use `code.edit` with text copied
   exactly from what you read; it is refused unless the text occurs once
   (or `replaceAll`), and touches nothing else. Write a file whole only when
   you are creating it or replacing most of it.
3. **Read the problems.** Every write returns the tree's `problems` after
   it: files that do not parse, imports and page references that point at
   nothing, packages not in the import map. Fix them before you stop. They
   are reported, never refused, so a change across several files can pass
   through a broken state on the way.
4. **On conflict, re-read and retry.** A write with `ifRevision` (or a
   removal with `ifChange`) is refused when someone changed the file or the
   tree since you read it. Read again, merge, retry.
5. **Undo with restore.** `code.restore` puts a file, a folder or the whole
   tree back as it stood after a change, as a new change. Nothing is lost.

## No bundler: what that means

- **Import files by their full name.** Browsers add no extensions:
  `import { x } from './util.js'`, never `'./util'`. Paths start with `./`,
  `../` or `/`; a bare name (`'util.js'`) is read as a package.
- **Pin packages, then import them by name.** `code.pin {tree, package:
  'preact'}` writes `imports.json` with the exact latest version (or the one
  a `version`, range or tag means) and its subpaths, so `import { h } from
  'preact'` and `'preact/hooks'` both resolve. Publishing adds the map to
  every page; do not write an inline `<script type="importmap">`.
- **No Node.** `fs`, `path` and `node:*` modules do not exist in a
  browser; neither do `process.env`, `require` or `package.json`.
- **Pages load modules directly**: `<script type="module" src="app.js">`.
- **No CSS tooling.** Plain CSS, `@import` and `url()` with paths that
  exist in the tree.

## Starting a tree

`code.create {name, starter: 'html'}` begins with a page, a stylesheet and
a module script, with no problems. Without a starter the tree is empty.
