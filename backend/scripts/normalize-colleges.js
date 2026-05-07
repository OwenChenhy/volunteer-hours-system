const { Pool } = require('pg');
const { createClient } = require('redis');
const {
  FORMAL_COLLEGES,
  normalizeCollegeName,
} = require('../src/utils/collegeNames');

const dryRun = process.argv.includes('--dry-run');

async function clearQueryCache(summary) {
  if (!process.env.REDIS_URL || dryRun) return;

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    let cursor = '0';
    let deleted = 0;
    do {
      const scan = await redis.scan(cursor, { MATCH: 'query:*', COUNT: 500 });
      cursor = String(scan.cursor);
      if (scan.keys.length > 0) {
        deleted += await redis.del(scan.keys);
      }
    } while (cursor !== '0');
    summary.redis_query_keys_deleted = deleted;
  } finally {
    await redis.quit().catch(() => {});
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const summary = {
    dry_run: dryRun,
    formal_colleges: FORMAL_COLLEGES,
    mappings: [],
    unknown_colleges: [],
    updated_rows: 0,
  };

  try {
    const current = await client.query(`
      SELECT COALESCE(NULLIF(college, ''), '') AS college,
             COUNT(*)::int AS rows,
             COALESCE(SUM(hours), 0)::numeric(12,1)::text AS hours
      FROM volunteer_logs
      GROUP BY COALESCE(NULLIF(college, ''), '')
      ORDER BY rows DESC, college
    `);

    for (const row of current.rows) {
      const college = row.college;
      if (!college) continue;

      const normalized = normalizeCollegeName(college);
      if (!FORMAL_COLLEGES.includes(normalized)) {
        summary.unknown_colleges.push({
          college,
          rows: row.rows,
          hours: row.hours,
        });
        continue;
      }

      if (normalized !== college) {
        summary.mappings.push({
          from: college,
          to: normalized,
          rows: row.rows,
          hours: row.hours,
        });
      }
    }

    if (summary.unknown_colleges.length > 0) {
      throw new Error(`Unknown colleges found: ${summary.unknown_colleges.map((item) => item.college).join(', ')}`);
    }

    await client.query('BEGIN');
    for (const mapping of summary.mappings) {
      const result = await client.query(
        'UPDATE volunteer_logs SET college = $1 WHERE college = $2',
        [mapping.to, mapping.from],
      );
      summary.updated_rows += result.rowCount;
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      summary.rolled_back = true;
    } else {
      await client.query('COMMIT');
      summary.committed = true;
      await clearQueryCache(summary);
    }

    const after = await client.query(`
      SELECT COALESCE(NULLIF(college, ''), '') AS college,
             COUNT(*)::int AS rows,
             COALESCE(SUM(hours), 0)::numeric(12,1)::text AS hours
      FROM volunteer_logs
      GROUP BY COALESCE(NULLIF(college, ''), '')
      ORDER BY rows DESC, college
    `);
    summary.after = after.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    summary.error = error.message;
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
