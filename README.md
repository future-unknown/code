# code

Source trees held in Known: files with history, read and written over an API by any agent, checked on every write, and published with no build step. A site's source can be a code tree or a GitHub repo; this package is the code tree.

The design and its reasoning are on the wiki page `roadmap.plans.code`. It follows the wiki package's layout and vocabulary: files take the page verbs (`read`, `write`, `edit`, `move`, `remove`), and a tree's history is its changes.

```
lib/kit/   the domain core: trees, files, changes, edit, grep, the import map, checks
lib/api/   the method declarations and table (createCodeMethods), an express router
lib/sdk/   the client (CodeClient)
SKILL.md   how an agent works on a tree with no filesystem and no bundler
```

## Model

- **A tree** is a named set of files. Paths are slash-separated; folders are implied by the files in them. Addresses join the two with a colon: `hello:src/app.js`.
- **A change** is one write: who made it, why, and what it did to each path it touched. Contents are stored once by SHA-256 (`code_blobs`); a change's revisions say which contents each path was left with, or that the file was removed (`code_revisions`); the tree as it is now is `code_files`. Any earlier state is read back from the revisions. A move is a removal and a revision that names where it came from, so history follows a file through it.
- **Checks** run on every write, over the whole tree, and come back as `problems`: files that do not parse (esbuild), imports that resolve to nothing (es-module-lexer, browser resolution rules: no extensions added), names imported from a tree's file that it does not export, HTML and CSS references to missing files (parse5), and bare package names missing from the import map. Analyses are cached by extension and contents.
- **The import map** is `imports.json` at the tree's root, in the browser's import-map shape. `code.pin` asks the npm registry which exact version a name (and an optional version, range or tag) means, and pins it on esm.sh with its subpaths.

## Storage

The kit is handed a better-sqlite3 connection and never opens one. Its tables are prefixed `code_` and its migrations are tracked in `code_migrations`, so it can share a database with other packages. Known keeps each org's trees in a file of their own, apart from its wikis. Files are capped at 1 MiB and trees at 1,000 files while binaries live in SQLite.

## Methods

| Method | Does |
|---|---|
| `code.list` | every tree the caller may read |
| `code.create {name, title?, description?, starter?}` | a new tree, empty or from a starter (`html`) |
| `code.update {tree, title?, description?}` | what a tree says about itself |
| `code.tree {path, depth?, changeId?}` | files and folders, folders first |
| `code.read {path, offset?, limit?, changeId?}` | a file: text as `content`, binary as `base64` |
| `code.write {path, content \| base64, ifRevision?, message?}` | a file whole |
| `code.edit {path, oldString, newString, replaceAll?, ifRevision?, message?}` | one exact string for another |
| `code.move {from, to, ifRevision?, message?}` | a file, or a folder and everything in it |
| `code.remove {path, recursive?, ifRevision?, ifChange?, message?}` | a file, or a folder with `recursive`; never a tree |
| `code.grep {pattern, path, regex?, ignoreCase?, context?, limit?}` | matching lines as path and line |
| `code.deps {tree}` / `code.pin {tree, package, version?}` / `code.unpin {tree, package}` | the import map |
| `code.history {path, limit?}` | a file's revisions, through moves |
| `code.getRevision {tree, revisionId}` | a revision and the one before it |
| `code.changes {path, limit?, before?}` | the tree's changes, each with its files |
| `code.getChange {tree, changeId}` | one change, with a unified patch per text file |
| `code.restore {path, changeId, ifChange?, message?}` | a file, folder or tree back as it stood, as a new change |
| `code.check {tree, changeId?}` | every problem in the tree |

Every write returns the tree's `problems` after it, and every path that comes back carries its `address`. A call meant for another method is refused naming it (`code.write does not take oldString: part of a file is changed with code.edit`). Authorization is the host's: each call asks `auth.authorize(principal, {action, tree, path})` with `code:read`, `code:write` or `code:create`.

## Development

```
pnpm install
pnpm test
pnpm dev:api        # http://localhost:3000, token dev-token, var/code.db
```

## Not here yet

Publishing to Surge, knapi and CLI wiring, and the browser render check are steps 2–4 of the plan.
