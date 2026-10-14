const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = new URL(process.env.LIFECYCLE_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/ux_lifecycle_review_test');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
process.env.DATABASE_URL = url.href;
const bcrypt = require('bcrypt');
const db = require('../src/db');
const { buildApp } = require('../src/app');
const importer = require('../src/services/importService');
const publication = require('../src/services/publicationService');
const query = require('../src/services/queryService');
const college = '计算机科学与工程学院';
const app = buildApp(), accounts = {}, checks = [];
const call = (role, method, route, payload) => app.inject({ method, url: '/api/v1' + route, payload,
  headers: { authorization: 'Bearer ' + accounts[role].token } });
async function expect(method, route, payload, status = 200) {
  const response = await call('admin', method, route, payload);
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  console.log((checks.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}
async function activity(name) {
  return expect('POST', '/activities', { name, org_name: college, start_time: '2026-10-14T09:00:00+08:00', end_time: '2026-10-14T12:00:00+08:00' }, 201);
}
const importRow = (student, name, extra = {}) => ({ student_id: student, student_name: '合成生命周期学生', college, grade: '26级',
  activity_name: name, activity_date: '2026-10-14', hours: 2.5, status: 'ok', problem_confirmed: true, ...extra });
async function imported(student, name, extra = {}) {
  const result = await importer.confirmImport([importRow(student, name, extra)], accounts.admin.id, '合成生命周期导入-' + student);
  assert.equal(result.count, 1);
  return (await db.query('SELECT * FROM volunteer_logs WHERE import_batch_id=$1', [result.batch_id])).rows[0];
}
async function online(student) {
  const parent = await activity('合成活动-' + student);
  await expect('POST', '/logs', { activity_id: parent.id, records: [{ student_id: student, student_name: '合成生命周期学生', college, grade: '26级', hours: 2.5 }] }, 201);
  const row = (await db.query('SELECT * FROM volunteer_logs WHERE activity_id=$1 AND student_id=$2', [parent.id, student])).rows[0];
  await expect('PATCH', '/logs/' + row.id + '/approve', {});
  await expect('DELETE', '/logs/' + row.id, { reason: '合成作废以重导' });
  return { parent, row };
}
async function assertLiveLink(row, excludedId) {
  const linked = (await db.query('SELECT a.id,a.deleted_at FROM volunteer_logs l JOIN activities a ON a.id=l.activity_id WHERE l.id=$1', [row.id])).rows[0];
  assert(linked, 'review did not associate an activity');
  assert.equal(linked.deleted_at, null, 'review associated a logically deleted activity');
  if (excludedId) assert.notEqual(linked.id, excludedId);
  return linked;
}
async function main() {
  await require('../src/db/ensureSchema').ensureSchema();
  const hash = await bcrypt.hash(process.env.LIFECYCLE_TEST_PASSWORD, 12);
  for (const role of ['admin', 'data_admin']) {
    accounts[role] = (await db.query('INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['lifecycle-' + role, hash, '合成审查-' + role, role, college])).rows[0];
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'lifecycle-' + role, password: process.env.LIFECYCLE_TEST_PASSWORD } });
    assert.equal(login.statusCode, 200, login.body); accounts[role].token = login.json().access_token;
  }
  await check('online restoration detects an unlinked import and publication stays at 2.5 hours', async () => {
    const student = 'LIFECYCLE-CROSS-SOURCE', { parent, row } = await online(student);
    const replacement = await imported(student, parent.name);
    assert.equal(replacement.activity_id, null);
    const restore = await call('admin', 'POST', '/logs/' + row.id + '/restore', { reason: '合成跨来源恢复' });
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: '合成跨来源公示' });
    const published = await query.queryStudentLogs(student, '合成生命周期学生');
    assert.equal(restore.statusCode, 409, JSON.stringify({ restore_status: restore.statusCode, published_hours: published.total_hours }));
    assert.equal(published.total_hours, 2.5); assert.equal(published.records.length, 1);
  });
  await check('pending and rejected imports also prevent duplicate online restoration', async () => {
    for (const status of ['pending', 'rejected']) {
      const student = 'LIFECYCLE-' + status, { parent, row } = await online(student);
      const replacement = await imported(student, parent.name);
      await db.query('UPDATE volunteer_logs SET status=$2 WHERE id=$1', [replacement.id, status]);
      await expect('POST', '/logs/' + row.id + '/restore', { reason: '合成有效状态恢复' }, 409);
      assert.equal((await db.query('SELECT status FROM volunteer_logs WHERE id=$1', [row.id])).rows[0].status, 'voided');
    }
  });
  await check('online adjustments remain distinct from normal hours but match equal imported adjustments', async () => {
    const student = 'LIFECYCLE-ADJUSTMENT', parent = await activity('合成调整活动');
    await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_id,activity_name,activity_date,hours,source,status)
      VALUES($1,'合成生命周期学生',$2,'26级',$3,$4,'2026-10-14',2.5,'online','approved')`, [student, college, parent.id, parent.name]);
    const adjustment = (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_id,activity_name,activity_date,hours,source,status,is_adjustment,adjustment_reason,lifecycle_previous_status)
      VALUES($1,'合成生命周期学生',$2,'26级',$3,$4,'2026-10-14',-0.5,'online','voided',true,'合成扣减','approved') RETURNING id`, [student, college, parent.id, parent.name])).rows[0];
    await expect('POST', '/logs/' + adjustment.id + '/restore', { reason: '合成调整恢复' });
    await expect('DELETE', '/logs/' + adjustment.id, { reason: '合成调整重导' });
    await imported(student, parent.name, { hours: -0.5, is_adjustment: true, adjustment_reason: '合成扣减' });
    await expect('POST', '/logs/' + adjustment.id + '/restore', { reason: '合成重复调整恢复' }, 409);
  });
  await check('unknown-date imported histories remain separate and can both be restored', async () => {
    const ids = [];
    for (let index = 0; index < 2; index++) ids.push((await db.query(`INSERT INTO volunteer_logs(student_id,student_name,activity_name,activity_date,hours,source,status,lifecycle_previous_status)
      VALUES('LIFECYCLE-UNKNOWN','合成历史学生','未知日期累计',NULL,2.5,'imported','voided','approved') RETURNING id`)).rows[0].id);
    for (const id of ids) await expect('POST', '/logs/' + id + '/restore', { reason: '合成未知日期恢复' });
    assert.equal((await db.query("SELECT count(*)::int AS count FROM volunteer_logs WHERE id=ANY($1::uuid[]) AND status='approved'", [ids])).rows[0].count, 2);
  });
  await check('a deleted empty activity is not reused when a new import is corrected', async () => {
    const deleted = await activity('合成已删除候选');
    await expect('DELETE', '/activities/' + deleted.id);
    const row = await imported('LIFECYCLE-DELETED', deleted.name);
    await expect('PATCH', '/reviews/logs/' + row.id, { hours: 3.5 });
    await assertLiveLink(row, deleted.id);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM volunteer_logs WHERE activity_id=$1 AND status IN ('pending','approved','rejected')", [deleted.id])).rows[0].count, 0);
  });
  await check('a candidate deleted during review cannot become the new record association', async () => {
    const candidate = await activity('合成并发删除候选');
    const row = await imported('LIFECYCLE-DELETE-RACE', candidate.name);
    const blocker = await db.pool.connect();
    let editing, settled;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [candidate.id]);
      editing = call('admin', 'PATCH', '/reviews/logs/' + row.id, { hours: 3.5 }).then(response => { settled = response; return response; });
      let observed = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const waits = (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%UPDATE volunteer_logs%' OR query LIKE '%FROM activities%')")).rows;
        if (settled || waits.length) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(observed, 'review did not reach the controlled candidate lock');
      await blocker.query('UPDATE activities SET deleted_at=now() WHERE id=$1', [candidate.id]);
      await blocker.query('COMMIT');
      const response = await editing;
      assert([200, 409].includes(response.statusCode), response.body);
      if (response.statusCode === 409) {
        assert.equal(Number((await db.query('SELECT hours FROM volunteer_logs WHERE id=$1', [row.id])).rows[0].hours), 2.5);
        assert.equal((await db.query('SELECT count(*)::int AS count FROM review_notes WHERE log_id=$1', [row.id])).rows[0].count, 0);
        await expect('PATCH', '/reviews/logs/' + row.id, { hours: 3.5 });
      }
      await assertLiveLink(row, candidate.id);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (editing) await editing; }
  });
  await check('a live candidate is reused and cannot be deleted after association', async () => {
    const candidate = await activity('合成可复用候选'), row = await imported('LIFECYCLE-LIVE', candidate.name);
    await expect('PATCH', '/reviews/logs/' + row.id, { hours: 3.5 });
    const linked = await assertLiveLink(row);
    assert.equal(linked.id, candidate.id);
    await expect('DELETE', '/activities/' + candidate.id, undefined, 409);
  });
  await check('an unknown historical date does not create a synthetic activity association', async () => {
    const row = (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,activity_name,activity_date,hours,source,status)
      VALUES('LIFECYCLE-UNDATED','合成历史学生','合成无日期活动',NULL,2.5,'imported','approved') RETURNING id`)).rows[0];
    const updated = await expect('PATCH', '/reviews/logs/' + row.id, { hours: 3.5 });
    assert.equal(updated.activity_id, null); assert.equal(updated.activity_date, null);
  });
}
main().catch(error => { checks.push({ name: 'lifecycle harness', passed: false, error: error.message }); }).finally(async () => {
  fs.writeFileSync(process.env.LIFECYCLE_RESULT_PATH || '/tmp/ux-lifecycle-result.json', JSON.stringify(checks, null, 2));
  await app.close(); await db.pool.end();
  if (checks.some(check => !check.passed)) process.exitCode = 1;
});
