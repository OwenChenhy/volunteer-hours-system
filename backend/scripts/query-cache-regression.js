const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('node:child_process');
const { createClient } = require('redis');

const testUrl = process.env.REDIS_QUERY_TEST_DATABASE_URL;
assert(testUrl && new URL(testUrl).pathname === '/redis_query_test'
  && new URL(testUrl).hostname === '127.0.0.1' && new URL(testUrl).port === '55436', 'dedicated local test database required');
const redisUrl = process.env.REDIS_QUERY_TEST_URL;
assert(redisUrl && new URL(redisUrl).hostname === '127.0.0.1' && new URL(redisUrl).port === '16381', 'dedicated local test Redis required');
process.env.DATABASE_URL = testUrl;
process.env.REDIS_URL = redisUrl;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

const backupFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-ops-backup-'));
fs.writeFileSync(path.join(backupFixture, 'fixture.json'), JSON.stringify({ synthetic: true }));
process.env.BACKUP_DIR = backupFixture;

const db = require('../src/db');
const publication = require('../src/services/publicationService');
const query = require('../src/services/queryService');
const cache = require('../src/cache/redis');
const { buildApp } = require('../src/app');
const app = buildApp();
const observer = createClient({ url: redisUrl, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
observer.on('error', () => {});
const checks = [];
const college = '合成缓存测试学院', otherCollege = '合成缓存第二学院';
const identity = { student_id: 'CACHE-001', student_name: '合成缓存甲' };
const peer = { student_id: 'CACHE-002', student_name: '合成缓存乙' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let requestNumber = 0;
const call = (input = identity, path = '') => app.inject({ method: 'POST', url: '/api/v1/query' + path, payload: input,
  headers: { 'x-real-ip': '192.0.2.' + ++requestNumber } });
const summaries = input => call({ ...identity, academic_year: '2026-2027', ...input }, '/summary');
const keys = async kind => {
  const found = [];
  for await (const page of observer.scanIterator({ MATCH: 'query:v1:' + kind + ':*' })) found.push(...page);
  return found;
};
async function check(name, run) {
  const started = Date.now();
  try { await run(); checks.push({ name, passed: true, ms: Date.now() - started }); }
  catch (error) { checks.push({ name, passed: false, error: error.message, ms: Date.now() - started }); }
  console.log((checks.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}
function child(code) {
  const result = spawnSync(process.execPath, ['-e', code], { env: process.env, cwd: process.cwd(), encoding: 'utf8', timeout: 12000 });
  assert.equal(result.status, 0, 'isolated child process failed: ' + (result.stderr || result.error?.message || '').slice(0, 400));
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function main() {
  await observer.connect();
  assert.equal(await observer.dbSize(), 0, 'test Redis must start empty');
  const admin = crypto.randomUUID();
  await db.query("INSERT INTO users(id,username,password_hash,real_name,role) VALUES($1,'query-cache-test','not-a-login-credential','合成管理员','admin')", [admin]);
  const row = (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status,created_at)
    VALUES($1,$2,$3,'26级','合成缓存活动甲','2026-10-10',3,'online','approved','2026-10-13T00:00:00Z') RETURNING id`,
    [identity.student_id, identity.student_name, college])).rows[0].id;
  await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status,created_at) VALUES
    ($1,$2,$3,NULL,'合成缺年级活动','2026-10-14',2,'imported','approved','2026-10-12T00:00:00Z'),
    ($4,$5,$3,'26级','合成缓存活动乙','2026-10-11',4,'online','approved','2026-10-13T00:00:00Z'),
    ($1,'合成同学号另名',$3,'26级','合成另名活动','2026-10-11',1,'online','approved','2026-10-13T00:00:00Z'),
    ('CACHE-003','合成其他学院',$6,'26级','合成其他活动','2026-10-11',3,'online','approved','2026-10-13T00:00:00Z')`,
    [identity.student_id, identity.student_name, college, peer.student_id, peer.student_name, otherCollege]);
  const first = await publication.publish(admin, { publication_month: '2026-10', label: '合成缓存基线' });
  await app.ready();
  const opsTokens = { admin: jwt.sign({ id: admin, session_version: 0, token_type: 'access' }, process.env.JWT_SECRET) };
  for (const role of ['super_admin', 'data_admin', 'auditor', 'college_admin', 'organizer']) {
    const id = crypto.randomUUID();
    await db.query('INSERT INTO users(id,username,password_hash,real_name,role) VALUES($1,$2,$3,$4,$5)',
      [id, 'cache-ops-' + role, 'not-a-login-credential', '合成运维账号', role]);
    opsTokens[role] = jwt.sign({ id, session_version: 0, token_type: 'access' }, process.env.JWT_SECRET);
  }
  const ops = (role = 'admin', path = '/status') => app.inject({ method: 'GET', url: '/api/v1/ops' + path,
    headers: role ? { authorization: 'Bearer ' + opsTokens[role] } : {} });
  await check('operations reports a healthy empty Redis with a live timestamp and no connection URL', async () => {
    const response = await ops(); assert.equal(response.statusCode, 200);
    const value = response.json().redis; assert(value, 'operations response is missing Redis status');
    assert.equal(value.status, 'ok'); assert.equal(value.ok, true); assert.equal(value.configured, true);
    assert.equal(value.keys, 0); assert(Date.now() - Date.parse(value.checked_at) < 2000);
    assert(!JSON.stringify(value).includes('redis://')); assert.equal(response.headers['cache-control'], 'no-store');
  });
  await check('operations Redis details retain the six-role access boundary', async () => {
    assert.equal((await ops(null)).statusCode, 401);
    for (const role of ['admin', 'super_admin', 'data_admin', 'auditor']) assert.equal((await ops(role)).statusCode, 200);
    for (const role of ['college_admin', 'organizer']) assert.equal((await ops(role)).statusCode, 403);
  });
  let progressReads = 0, summaryBuilds = 0;
  const originalQuery = db.query, originalSummary = publication.summary;
  db.query = async (sql, params) => {
    if (sql.includes('FROM volunteer_logs WHERE student_id=$1 AND student_name=$2')) progressReads++;
    return originalQuery(sql, params);
  };
  publication.summary = (...args) => { summaryBuilds++; return originalSummary(...args); };
  const counter = async () => Number((await originalQuery("SELECT value FROM public_counters WHERE name='student_queries'")).rows[0]?.value || 0);
  let studentKey;

  await check('first HTTP student query writes a Redis result with a five-minute TTL', async () => {
    const response = await call(); assert.equal(response.statusCode, 200, response.body);
    const payload = response.json(); assert.equal(payload.total_hours, 5); assert.equal(payload.grade, '26级');
    assert.equal(payload.academic_summaries[0].rank, 1); assert(payload.records.every(record => !('id' in record)));
    assert.equal(response.headers['cache-control'], 'no-store');
    studentKey = (await keys('student'))[0]; assert(studentKey, 'no student result was written to Redis');
    assert(!studentKey.includes(identity.student_id) && !studentKey.includes(identity.student_name));
    const ttl = await observer.ttl(studentKey); assert(ttl > 0 && ttl <= 300);
  });
  await check('operations and its monitoring alias refresh the actual Redis key count', async () => {
    const before = (await ops()).json().redis; assert(before, 'operations response is missing Redis status');
    assert.equal(before.keys, await observer.dbSize());
    await observer.set('ops:synthetic-key', 'fixture', { EX: 60 });
    try {
      const response = await ops('admin', '/monitoring'); assert.equal(response.statusCode, 200);
      assert.equal(response.json().redis.keys, before.keys + 1);
      assert.equal(response.headers['cache-control'], 'no-store');
    } finally { await observer.del('ops:synthetic-key'); }
  });
  await check('repeat HTTP queries hit Redis, skip business record reads, and still count visits', async () => {
    const beforeReads = progressReads, beforeCount = await counter();
    const one = (await call()).json();
    for (let i = 0; i < 8; i++) {
      const response = await call(); assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), one);
    }
    assert.equal(progressReads - beforeReads, 0, 'warm queries must not re-read volunteer_logs');
    assert.equal(await counter() - beforeCount, 9);
  });
  await check('normalized identity uses the same cached result', async () => {
    const before = progressReads;
    const response = await call({ student_id: ' CACHE-001 ', student_name: ' 合成缓存甲 ' });
    assert.equal(response.statusCode, 200); assert.equal(response.json().total_hours, 5); assert.equal(progressReads, before);
  });
  await check('another backend process reuses the same Redis result', async () => {
    const result = child(`const db=require('./src/db');const original=db.query;db.query=(sql,args)=>{if(sql.includes('FROM volunteer_logs WHERE student_id=$1 AND student_name=$2'))throw Error('cache miss');return original(sql,args)};
      (async()=>{const value=await require('./src/services/queryService').queryStudentLogs('CACHE-001','合成缓存甲');
      console.log(JSON.stringify({hours:value.total_hours}));await require('./src/cache/redis').close();await db.pool.end()})().catch(()=>process.exit(1));`);
    assert.equal(result.hours, 5);
  });
  await check('parallel cold queries share one database load', async () => {
    const before = progressReads;
    const results = await Promise.all(Array.from({ length: 20 }, () => query.queryStudentLogs('CACHE-003', '合成其他学院')));
    assert(results.every(value => value.total_hours === 3)); assert.equal(progressReads - before, 1);
  });
  await check('wrong names and matching IDs with other names never reuse personal results', async () => {
    assert.equal((await call({ ...identity, student_name: '不存在姓名' })).statusCode, 404);
    const other = await call({ ...identity, student_name: '合成同学号另名' });
    assert.equal(other.statusCode, 200); assert.equal(other.json().total_hours, 1);
    const scoped = await query.queryStudentLogs(identity.student_id, identity.student_name, otherCollege);
    assert.equal(scoped, null);
  });
  await check('cached ranking uses the canonical student profile and hides other identities', async () => {
    const response = await summaries(); assert.equal(response.statusCode, 200, response.body);
    const payload = response.json(); assert.equal(payload.college, college); assert.equal(payload.grade, '26级');
    const own = payload.rows.find(value => value.is_self); assert.equal(own.student_id, identity.student_id); assert.equal(own.total_hours, 5);
    assert(payload.rows.filter(value => !value.is_self).every(value => !value.student_id.includes('CACHE') && value.student_name.includes('*')));
    assert(!(payload.rows.some(value => value.student_name === '合成其他学院')));
    assert((await keys('summary')).length > 0); assert.equal(response.headers['cache-control'], 'no-store');
  });
  await check('ranking cache hits skip rebuilding rankings and preserve per-student masking', async () => {
    const before = summaryBuilds, response = await summaries(); assert.equal(response.statusCode, 200); assert.equal(summaryBuilds, before);
    const other = await summaries(peer); assert.equal(other.statusCode, 200);
    assert.equal(other.json().rows.find(value => value.is_self).student_id, peer.student_id);
    assert(other.json().rows.find(value => value.total_hours === 5).student_id.includes('*'));
    assert.equal((await summaries()).json().rows.find(value => value.is_self).student_id, identity.student_id);
  });
  await check('ranking pages, limits and invalid identities are separated before cache lookup', async () => {
    const firstPage = await summaries({ limit: 1 }), secondPage = await summaries({ limit: 1, page: 2 });
    assert.equal(firstPage.statusCode, 200); assert.equal(secondPage.statusCode, 200);
    assert.equal(firstPage.json().rows.length, 1); assert.equal(firstPage.json().rows[0].rank, 1);
    assert.equal(secondPage.json().rows[0].rank, 2);
    assert.equal((await summaries({ student_name: '不存在姓名' })).statusCode, 404);
    assert.equal((await summaries({ academic_year: '2026-2028' })).statusCode, 400);
  });
  await check('editing approved draft hours invalidates progress without changing published totals', async () => {
    await originalQuery('UPDATE volunteer_logs SET hours=4 WHERE id=$1', [row]); await sleep(1100);
    const response = await call(); assert.equal(response.statusCode, 200);
    assert.equal(response.json().total_hours, 5); assert.equal(response.json().review_progress[0].hours, 4);
    assert.equal(response.json().review_progress[0].status, 'approved'); assert.equal(response.json().data_version.publication_id, first.batch.id);
  });
  await check('pending-only students and rejected progress refresh before publication', async () => {
    const pending = (await originalQuery(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status)
      VALUES('CACHE-PENDING','合成待审学生',$1,'26级','合成待审活动','2026-10-15',1,'online','pending') RETURNING id`, [college])).rows[0].id;
    await sleep(1100);
    const input = { student_id: 'CACHE-PENDING', student_name: '合成待审学生' };
    const pendingResult = await call(input); assert.equal(pendingResult.statusCode, 200); assert.equal(pendingResult.json().total_hours, 0);
    assert.equal(pendingResult.json().review_progress[0].status, 'pending');
    await originalQuery("UPDATE volunteer_logs SET status='rejected',reject_reason='合成未核实' WHERE id=$1", [pending]); await sleep(1100);
    const rejected = await call(input); assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().review_progress[0].status, 'rejected'); assert.equal(rejected.json().review_progress[0].reject_reason, '合成未核实');
  });
  await check('publishing a new version bypasses old personal and ranking results immediately', async () => {
    const next = await publication.publish(admin, { publication_month: '2026-10', label: '合成更正公示' });
    assert.notEqual(next.batch.id, first.batch.id);
    const result = await call(); assert.equal(result.statusCode, 200); assert.equal(result.json().total_hours, 6);
    assert.equal(result.json().review_progress.length, 0); assert.equal(result.json().data_version.publication_id, next.batch.id);
    assert.equal((await summaries()).json().rows.find(value => value.is_self).total_hours, 6);
    assert.equal((await summaries({ publication_id: first.batch.id })).statusCode, 409);
  });
  await check('a publication from another process refreshes this process within the version interval', async () => {
    const switched = child(`(async()=>{const db=require('./src/db');await db.query("INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status) VALUES('CACHE-001','合成缓存甲','合成缓存测试学院','26级','合成跨进程活动','2026-10-15',1,'online','approved')");
      const value=await require('./src/services/publicationService').publish('${admin}',{publication_month:'2026-10',label:'合成跨进程公示'});
      console.log(JSON.stringify({id:value.batch.id}));await require('./src/cache/redis').close();await db.pool.end()})().catch(()=>process.exit(1));`);
    await sleep(1100); const result = await call();
    assert.equal(result.json().total_hours, 7); assert.equal(result.json().data_version.publication_id, switched.id);
  });
  await check('cached queries never replace the editable admin draft lookup', async () => {
    await originalQuery('UPDATE volunteer_logs SET hours=5 WHERE id=$1', [row]);
    const draft = await query.queryDraftStudentLogs(identity.student_id, identity.student_name);
    assert.equal(draft.total_hours, 8); assert(draft.records.every(record => record.id));
    await originalQuery('UPDATE volunteer_logs SET hours=4 WHERE id=$1', [row]); await sleep(1100); await call();
  });
  await check('expired or corrupt JSON results are safely rebuilt', async () => {
    const state = await publication.current();
    const currentKeys = (await keys('student')).filter(key => key.includes(state.batch.id));
    const ownKeys = [];
    for (const candidate of currentKeys) {
      const value = JSON.parse(await observer.get(candidate));
      if (value.student_id === identity.student_id && value.student_name === identity.student_name) ownKeys.push(candidate);
    }
    assert(ownKeys.length);
    await Promise.all(ownKeys.map(key => observer.expire(key, 1))); await sleep(1100);
    let before = progressReads; assert.equal((await call()).json().total_hours, 7); assert.equal(progressReads - before, 1);
    const ownKey = (await keys('student')).find(key => key.includes(state.batch.id));
    assert(ownKey);
    await observer.set(ownKey, '{invalid-json', { EX: 300 }); before = progressReads;
    assert.equal((await call()).json().total_hours, 7); assert.equal(progressReads - before, 1);
    assert((await observer.ttl(ownKey)) > 0);
  });
  await check('a stalled Redis command falls back within the timeout', async () => {
    await observer.sendCommand(['CLIENT', 'PAUSE', '1500', 'ALL']);
    const started = Date.now(), before = progressReads;
    const response = await call(); assert.equal(response.statusCode, 200); assert.equal(response.json().total_hours, 7);
    assert(Date.now() - started < 1200, 'Redis must not stall student queries'); assert.equal(progressReads - before, 1);
  });
  await check('operations warns promptly during Redis failure while student queries still work', async () => {
    const started = Date.now(), response = await ops(); assert.equal(response.statusCode, 200);
    const value = response.json(); assert(value.redis, 'operations response is missing Redis status');
    assert.equal(value.redis.status, 'warning'); assert.equal(value.redis.ok, false); assert.equal(value.redis.keys, null);
    assert(value.monitoring.alerts.some(alert => alert.code === 'redis_unavailable' && alert.level === 'warning'));
    assert.equal(value.monitor.status, 'warning'); assert(Date.now() - started < 1200);
  });
  await check('Redis reconnects after failure without restarting the backend', async () => {
    await sleep(5100); const before = progressReads;
    const response = await call(); assert.equal(response.statusCode, 200); assert.equal(response.json().total_hours, 7);
    assert.equal(progressReads, before, 'recovered Redis must resume cache hits');
  });
  await check('operations clears the Redis warning after the connection recovers', async () => {
    const response = await ops(), value = response.json(); assert(value.redis, 'operations response is missing Redis status');
    assert.equal(value.redis.status, 'ok'); assert.equal(value.redis.keys, await observer.dbSize());
    assert(!value.monitoring.alerts.some(alert => alert.code === 'redis_unavailable'));
  });
  await check('an unresponsive TCP handshake is bounded and does not prevent queries', async () => {
    await cache.close(); const sockets = new Set();
    const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.REDIS_URL = 'redis://127.0.0.1:' + server.address().port;
    try {
      const started = Date.now(), response = await call(); assert.equal(response.statusCode, 200);
      assert.equal(response.json().total_hours, 7); assert(Date.now() - started < 1800);
    } finally {
      await cache.close(); for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve)); process.env.REDIS_URL = redisUrl;
    }
  });
  await check('Redis absent from configuration preserves the public query contract', async () => {
    await cache.close(); process.env.REDIS_URL = '';
    try {
      const response = await call(); assert.equal(response.statusCode, 200); assert.equal(response.json().total_hours, 7);
      const status = (await ops()).json().redis; assert(status, 'operations response is missing Redis status');
      assert.equal(status.status, 'disabled'); assert.equal(status.configured, false); assert.equal(status.keys, null);
    } finally { process.env.REDIS_URL = redisUrl; }
  });
  await check('invalid Redis configuration fails open instead of returning a query error', async () => {
    await cache.close(); process.env.REDIS_URL = 'invalid-redis-url';
    try { const response = await call(); assert.equal(response.statusCode, 200); assert.equal(response.json().total_hours, 7); }
    finally { await cache.close(); process.env.REDIS_URL = redisUrl; }
  });
  await check('operations never exposes Redis credentials when the configured server is unreachable', async () => {
    await cache.close(); process.env.REDIS_URL = 'redis://ops-private-user:ops-private-password@127.0.0.1:1/0';
    try {
      const response = await ops(); assert.equal(response.statusCode, 200);
      const value = response.json().redis; assert(value, 'operations response is missing Redis status');
      assert.equal(value.status, 'warning'); assert.equal(value.configured, true); assert.equal(value.keys, null);
      assert(!JSON.stringify(value).includes('ops-private')); assert(!JSON.stringify(value).includes('redis://'));
      assert.equal((await call()).statusCode, 200);
    } finally { await cache.close(); process.env.REDIS_URL = redisUrl; }
  });
  await check('failed database loads are not cached and the next request can retry', async () => {
    await cache.deleteByPrefix('query:'); const monitored = db.query;
    db.query = (sql, args) => {
      if (sql.includes('FROM volunteer_logs WHERE student_id=$1 AND student_name=$2')) throw Error('synthetic record read failure');
      return monitored(sql, args);
    };
    try { assert.equal((await call()).statusCode, 500); }
    finally { db.query = monitored; }
    const response = await call(); assert.equal(response.statusCode, 200); assert.equal(response.json().total_hours, 7);
  });
  await check('warm repeated service queries avoid all business record reads', async () => {
    await call(); const before = progressReads;
    for (let i = 0; i < 100; i++) assert.equal((await query.queryStudentLogs(identity.student_id, identity.student_name)).total_hours, 7);
    assert.equal(progressReads, before);
  });
  db.query = originalQuery; publication.summary = originalSummary;
}

main().catch(error => checks.push({ name: 'isolated cache harness', passed: false, error: error.message })).finally(async () => {
  if (process.env.REDIS_QUERY_RESULT_PATH) fs.writeFileSync(process.env.REDIS_QUERY_RESULT_PATH, JSON.stringify(checks, null, 2));
  await app.close(); await cache.close(); if (observer.isOpen) observer.destroy(); await db.pool.end();
  fs.rmSync(backupFixture, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: checks.filter(value => value.passed).length, failed: checks.filter(value => !value.passed).length }));
  if (checks.some(value => !value.passed)) process.exitCode = 1;
});
