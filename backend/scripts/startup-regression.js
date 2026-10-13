const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const url = new URL(process.env.STARTUP_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/ux_startup_test');
assert(['localhost', '127.0.0.1'].includes(url.hostname));
process.env.DATABASE_URL = url.href;
const db = require('../src/db');
const migrations = path.join(__dirname, '../src/db/migrations');
const results = [];
const probe = `
  (async () => {
    const db = require('./src/db');
    try {
      await require('./src/db/ensureSchema').ensureSchema();
      await require('./src/services/publicationService').current();
      const app = require('./src/app').buildApp();
      const response = await app.inject({ method: 'GET', url: '/health' });
      require('node:assert/strict').equal(response.statusCode, 200);
      await app.close();
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await db.pool.end(); }
  })();
`;

async function reset(files = []) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of files) await db.query(fs.readFileSync(path.join(migrations, file), 'utf8'));
}

async function verifySchema() {
  const roles = (await db.query("SELECT enumlabel FROM pg_enum WHERE enumtypid='user_role'::regtype")).rows.map(row => row.enumlabel);
  for (const role of ['organizer', 'admin', 'super_admin', 'data_admin', 'college_admin', 'auditor']) assert(roles.includes(role));
  await db.query('SELECT activity_period,academic_year,lifecycle_reason,submission_hash FROM volunteer_logs LIMIT 0');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public_counters')).rows[0].count, 2);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM publication_state')).rows[0].count, 1);
}

async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
  console.log((results.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}

function boot() {
  const result = spawnSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, (result.stderr || result.error?.message || 'startup failed').slice(-1000));
}

async function main() {
  await check('empty database initializes before publication startup', async () => {
    await reset(); boot(); await verifySchema();
  });
  await check('Compose 001-only database receives every subsequent migration', async () => {
    await reset(['001_init.sql']); boot(); await verifySchema();
  });
  await check('existing database survives repeated startup without losing data', async () => {
    await reset(fs.readdirSync(migrations).filter(file => file.endsWith('.sql')).sort());
    await db.query("INSERT INTO users(username,password_hash,real_name,role) VALUES('startup-preserved','synthetic-hash','Startup Fixture','admin')");
    boot(); boot(); await verifySchema();
    assert.equal((await db.query("SELECT count(*)::int AS count FROM users WHERE username='startup-preserved'")).rows[0].count, 1);
  });
  await check('concurrent initialization serializes the full migration chain', async () => {
    await reset();
    const { ensureSchema } = require('../src/db/ensureSchema');
    await Promise.all([ensureSchema(), ensureSchema()]);
    boot(); await verifySchema();
  });
}

main().catch(error => { results.push({ name: 'startup harness', passed: false, error: error.message }); }).finally(async () => {
  fs.writeFileSync(process.env.REVIEW_RESULT_PATH || '/tmp/ux-startup-result.json', JSON.stringify(results, null, 2));
  await db.pool.end();
  if (results.some(result => !result.passed)) process.exitCode = 1;
});
