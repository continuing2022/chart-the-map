const { createServer } = require('./app')
const { loadConfig } = require('./config')
const { createDatabasePool, runMigrations } = require('./db')

async function start() {
  const config = loadConfig()
  const databasePool = createDatabasePool(config)
  if (databasePool) await runMigrations(databasePool)

  const server = createServer({ config, databasePool })
  const port = server.application.config.port
  server.listen(port, '0.0.0.0', () => {
    console.log(`meal-diary-api listening on ${port}`)
  })

  const shutdown = () => {
    server.close(async () => {
      if (databasePool) await databasePool.end()
      process.exit(0)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

start().catch((error) => {
  console.error('server_start_failed', { code: error.code || 'START_FAILED', message: error.message })
  process.exit(1)
})
