const assert = require('assert');
assert.strictEqual(new URL(process.env.DATABASE_URL).pathname, '/academic_test', 'package smoke requires the isolated test database');
const { ensureSchema } = require('../src/db/ensureSchema');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const cache = require('../src/cache/redis');
(async () => {
  await ensureSchema();
  const app = buildApp();
  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.strictEqual(health.statusCode, 200);
    const query = await app.inject({ method: 'POST', url: '/api/v1/query', payload: { student_id: 'BOUNDARY-001', student_name: '边界样例' } });
    assert.strictEqual(query.statusCode, 200);
    assert.strictEqual(query.json().records[0].activity_date, '2026-09-01');
    assert.strictEqual(query.json().academic_summaries[0].vacation_hours, 1);
    console.log(JSON.stringify({ packaged_backend: 'passed', schema_startup: 'passed', health: 'passed', academic_query: 'passed' }));
  } finally { await app.close(); await cache.close(); await db.pool.end(); }
})().catch(async (err) => { console.error(err); await cache.close().catch(() => {}); await db.pool.end().catch(() => {}); process.exitCode = 1; });
