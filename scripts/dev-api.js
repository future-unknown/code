#!/usr/bin/env node
/**
 * Development server for the code API. The application owns the
 * Express app and the database connection; code provides the router
 * and the kit.
 *
 *   CODE_DB         SQLite file (default var/code.db)
 *   CODE_DEV_TOKEN  bearer token accepted in development (default dev-token)
 *   PORT            listen port (default 3000)
 */

import express from 'express'
import { createCodeKit } from '../lib/kit/index.js'
import { createCodeRouter, createStaticTokenAuth, openDatabase } from '../lib/api/index.js'

const file = process.env.CODE_DB || 'var/code.db'
const token = process.env.CODE_DEV_TOKEN || 'dev-token'
const port = Number(process.env.PORT || 3000)

const db = openDatabase(file)
const kit = createCodeKit({ db })
await kit.migrate()

const auth = createStaticTokenAuth({
  tokens: {
    [token]: { actor: { type: 'human', id: 'dev', onBehalfOf: null } }
  }
})

const app = express()
app.use(createCodeRouter({ kit, auth, onError: (error) => console.error(error) }))

const server = app.listen(port, () => {
  console.log(`code api listening on http://localhost:${port} (db: ${file})`)
})

const close = () => {
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
