const db = require('./index');
const fs = require('fs');
const path = require('path');

async function ensureSchema() {
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(927644)');
    const initialized = (await client.query("SELECT to_regclass('public.users') AS users")).rows[0].users;
    const directory = path.join(__dirname, 'migrations');
    // Compose initializes only 001; subsequent migrations are safe to replay in order.
    for (const file of fs.readdirSync(directory).filter(file => /^\d+_.*\.sql$/.test(file)).sort()) {
      if (file === '001_init.sql' && initialized) continue;
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
    }
    await client.query(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID REFERENCES users(id),
      username    VARCHAR(64),
      action      VARCHAR(64) NOT NULL,
      target_type VARCHAR(64),
      target_id   UUID,
      detail      JSONB,
      ip          VARCHAR(64),
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `);

    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at
    ON operation_logs(created_at DESC)
  `);

    await client.query(`
    CREATE TABLE IF NOT EXISTS review_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      log_id UUID REFERENCES volunteer_logs(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id),
      username VARCHAR(64),
      action VARCHAR(64) NOT NULL,
      detail JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_review_notes_log_id
    ON review_notes(log_id)
  `);

    await client.query(`
    CREATE INDEX IF NOT EXISTS idx_review_notes_created_at
    ON review_notes(created_at DESC)
  `);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(927644)'); }
    finally { client.release(); }
  }
}

module.exports = { ensureSchema };
