import Database from 'better-sqlite3'
import { createCodeKit } from '../../lib/kit/index.js'

export const human = { type: 'human', id: 'user_test', onBehalfOf: null }
export const agent = { type: 'agent', id: 'agent_test', onBehalfOf: 'user_test' }

/**
 * A resolver that answers without the network: every package's latest
 * is 1.2.3, and a version given is taken as it is.
 */
export async function fakeResolver (name, wanted) {
  const version = wanted ?? '1.2.3'
  return { name, version, url: `https://esm.sh/${name}@${version}` }
}

/**
 * Fresh in-memory kit for a test. The db handle is exposed so tests can
 * assert directly against SQLite state.
 */
export async function createTestKit ({ resolvePackage = fakeResolver } = {}) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const kit = createCodeKit({ db, resolvePackage })
  await kit.migrate()
  return { kit, db }
}

/** A kit with an empty tree named hello. */
export async function withTree (options) {
  const { kit, db } = await createTestKit(options)
  const { tree } = await kit.createTree({ name: 'hello', actor: human })
  return { kit, db, treeId: tree.id }
}
