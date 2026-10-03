const { Pool } = require('pg')
const { runMigrations } = require('./migrate')

function createDatabasePool(config) {
  if (!config.databaseUrl) return null
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    max: Math.max(1, config.databasePoolMax),
    ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {})
  })
  pool.on('error', (error) => {
    console.error('database_pool_error', { code: error.code || 'DATABASE_ERROR' })
  })
  return pool
}

module.exports = { createDatabasePool, runMigrations }
