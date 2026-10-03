const fs = require('node:fs/promises')
const path = require('node:path')

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

async function runMigrations(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('meal-diary-schema-migrations'))")
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort()
    const appliedResult = await client.query('SELECT name FROM schema_migrations')
    const applied = new Set(appliedResult.rows.map((row) => row.name))

    for (const name of files) {
      if (applied.has(name)) continue
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
      console.log(`database migration applied: ${name}`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

module.exports = { runMigrations }
