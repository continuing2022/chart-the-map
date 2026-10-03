const { loadConfig } = require('../config')
const { createDatabasePool, runMigrations } = require('../db')

async function main() {
  const config = loadConfig()
  const pool = createDatabasePool(config)
  if (!pool) throw new Error('DATABASE_URL 未配置。')
  try {
    await runMigrations(pool)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('database_migration_failed', { code: error.code || 'MIGRATION_FAILED', message: error.message })
  process.exit(1)
})
