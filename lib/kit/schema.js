/**
 * Explicit SQL migrations. code-kit owns the schema; the caller owns
 * the connection.
 *
 * The host decides which database the tables live in, and may share
 * it with other packages, so every table is prefixed `code_` and
 * migrations are tracked in `code_migrations`, apart from anyone
 * else's. Known keeps each org's trees in a file of their own.
 */

export const migrations = [
  {
    id: '001-core',
    sql: `
      CREATE TABLE code_trees (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        title         TEXT,
        description   TEXT,
        deleted       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      -- Active names are unique; a removed tree frees its name.
      CREATE UNIQUE INDEX code_trees_active_name ON code_trees(name) WHERE deleted = 0;

      -- One change per write: who, why, when.
      CREATE TABLE code_changes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id       TEXT NOT NULL,

        actor_type    TEXT NOT NULL,
        actor_id      TEXT NOT NULL,
        on_behalf_of  TEXT,
        actor_org     TEXT,
        via           TEXT,

        message       TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX code_changes_by_tree ON code_changes(tree_id, id);

      -- File contents by SHA-256, shared by every revision that has them.
      CREATE TABLE code_blobs (
        hash          TEXT PRIMARY KEY,
        size          INTEGER NOT NULL,
        binary        INTEGER NOT NULL,
        content       BLOB NOT NULL
      );

      -- What a change did to one path: the contents it left, or none
      -- when it removed the file. A move is a removal at the old path
      -- and a revision at the new one that names where it came from.
      CREATE TABLE code_revisions (
        id            TEXT PRIMARY KEY,
        tree_id       TEXT NOT NULL,
        change_id     INTEGER NOT NULL,
        path          TEXT NOT NULL,
        hash          TEXT,
        moved_from    TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX code_revisions_by_path ON code_revisions(tree_id, path, change_id);
      CREATE INDEX code_revisions_by_change ON code_revisions(change_id);

      -- The tree as it is now: one row per file.
      CREATE TABLE code_files (
        tree_id       TEXT NOT NULL,
        path          TEXT NOT NULL,
        hash          TEXT NOT NULL,
        revision_id   TEXT NOT NULL,
        change_id     INTEGER NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (tree_id, path)
      );
    `
  }
]

export function migrate (db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );
    `)
    const applied = new Set(
      db.prepare('SELECT id FROM code_migrations').all().map((row) => row.id)
    )
    const insert = db.prepare('INSERT INTO code_migrations (id, applied_at) VALUES (?, ?)')
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue
      db.exec(migration.sql)
      insert.run(migration.id, new Date().toISOString())
    }
  }).immediate()
}
