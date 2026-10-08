const db = require('./index');
const fs = require('fs');
const path = require('path');

async function ensureSchema() {
  await db.query(fs.readFileSync(path.join(__dirname, 'migrations/005_academic_hours.sql'), 'utf8'));
  await db.query(`
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

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at
    ON operation_logs(created_at DESC)
  `);

  await db.query(`
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

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_review_notes_log_id
    ON review_notes(log_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_review_notes_created_at
    ON review_notes(created_at DESC)
  `);
}

module.exports = { ensureSchema };
