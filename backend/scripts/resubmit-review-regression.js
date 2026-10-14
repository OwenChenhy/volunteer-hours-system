const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = new URL(process.env.RESUBMIT_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/ux_resubmit_review_test');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
process.env.DATABASE_URL = url.href;
const db = require('../src/db');
const app = require('../src/app').buildApp();
const importer = require('../src/services/importService');
const publication = require('../src/services/publicationService');
const query = require('../src/services/queryService');
const accounts = {}, checks = [], college = '计算机科学与工程学院', studentName = '合成重提学生';
const call = (role, method, path, payload) => app.inject({ method, url: '/api/v1' + path, payload,
  headers: { authorization: 'Bearer ' + accounts[role].token } });
async function expect(role, method, path, payload, status = 200) {
  const response = await call(role, method, path, payload);
  assert.equal(response.statusCode, status, response.body);
  return response.json();
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  console.log((checks.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}
const record = student => ({ student_id: student, student_name: studentName, college, grade: '26级', hours: 2.5 });
async function withdrawn(student) {
  const activity = await expect('organizer', 'POST', '/activities', { name: '合成重提活动-' + student,
    org_name: college, start_time: '2026-10-14T09:00:00+08:00', end_time: '2026-10-14T12:00:00+08:00' }, 201);
  await expect('organizer', 'POST', '/logs', { activity_id: activity.id, records: [record(student)] }, 201);
  const row = (await db.query('SELECT * FROM volunteer_logs WHERE activity_id=$1', [activity.id])).rows[0];
  await expect('organizer', 'DELETE', '/logs/' + row.id, { reason: '合成撤回后重导' });
  return { activity, row };
}
const importRow = (student, activity, extra = {}) => ({ ...record(student), activity_name: activity.name,
  activity_date: '2026-10-14', status: 'ok', problem_confirmed: true, ...extra });
async function imported(student, activity, extra = {}) {
  const result = await importer.confirmImport([importRow(student, activity, extra)], accounts.admin.id, '合成重提导入-' + student);
  assert.equal(result.count, 1);
  const row = (await db.query('SELECT * FROM volunteer_logs WHERE import_batch_id=$1', [result.batch_id])).rows[0];
  assert.equal(row.activity_id, null);
  return row;
}
async function legacy(student, name) {
  return (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status)
    VALUES($1,$2,$3,'26级',$4,NULL,2.5,'imported','approved') RETURNING *`, [student, studentName, college, name])).rows[0];
}
function editorPayload(student, row, changed) {
  return { student_id: student.student_id, student_name: student.student_name, college: student.college, grade: student.grade,
    activity_name: row.activity_name, activity_date: row.activity_date,
    academic_year: row.academic_year === 'legacy' ? '' : row.academic_year, academic_term: row.academic_term,
    hours: row.hours, sync_student_info: true, note: '合成后台更正', ...changed };
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('controlled concurrent writer did not reach its lock');
}
async function competingImport(importFirst) {
  const student = importFirst ? 'RESUBMIT-IMPORT-FIRST' : 'RESUBMIT-EDIT-FIRST';
  const { activity, row } = await withdrawn(student), blocker = await db.pool.connect();
  let resubmit, loading;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE volunteer_logs IN SHARE MODE');
    const startResubmit = () => { resubmit = call('organizer', 'PATCH', '/logs/' + row.id + '/resubmit', { hours: 2.5 }); };
    const startImport = () => { loading = importer.confirmImport([importRow(student, activity)], accounts.admin.id, '合成并发重导-' + student); };
    if (importFirst) startImport(); else startResubmit();
    await waitFor(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%volunteer_logs%' AND (query LIKE '%UPDATE%' OR query LIKE '%INSERT%')")).rowCount > 0);
    if (importFirst) startResubmit(); else startImport();
    await waitFor(async () => (await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE '%volunteer_logs%' OR query LIKE '%pg_advisory_xact_lock%')")).rowCount >= 2);
    await blocker.query('COMMIT');
    const [response, result] = await Promise.all([resubmit, loading]);
    const count = (await db.query("SELECT count(*)::int AS count FROM volunteer_logs WHERE student_id=$1 AND status IN ('pending','approved','rejected')", [student])).rows[0].count;
    assert.equal(count, 1, JSON.stringify({ effective_records: count, resubmit_status: response.statusCode, imported: result.count }));
    if (importFirst) { assert([400, 409].includes(response.statusCode)); assert.equal(result.count, 1); }
    else { assert.equal(response.statusCode, 200); assert.equal(result.count, 0); }
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await Promise.allSettled([resubmit, loading].filter(Boolean));
  }
}
async function main() {
  await require('../src/db/ensureSchema').ensureSchema();
  const hash = await require('bcrypt').hash(process.env.RESUBMIT_TEST_PASSWORD, 12);
  for (const role of ['admin', 'organizer']) {
    accounts[role] = (await db.query('INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['resubmit-' + role, hash, '合成重提账号', role, college])).rows[0];
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'resubmit-' + role, password: process.env.RESUBMIT_TEST_PASSWORD } });
    assert.equal(login.statusCode, 200); accounts[role].token = login.json().access_token;
  }
  await check('resubmission after a replacement import cannot publish duplicate 2.5-hour records', async () => {
    const student = 'RESUBMIT-PUBLICATION', { activity, row } = await withdrawn(student);
    await imported(student, activity);
    const response = await call('organizer', 'PATCH', '/logs/' + row.id + '/resubmit', { hours: 2.5 });
    if (response.statusCode === 200) await expect('admin', 'PATCH', '/logs/' + row.id + '/approve', {});
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: '合成重提公示' });
    const result = await query.queryStudentLogs(student, studentName);
    assert([400, 409].includes(response.statusCode), JSON.stringify({ resubmit_status: response.statusCode, published_hours: result.total_hours }));
    assert.equal(result.total_hours, 2.5); assert.equal(result.records.length, 1);
  });
  const originalName = '源表未拆分累计-合成查找';
  const original = await legacy('RESUBMIT-RAW-NAME', originalName);
  await check('editable draft lookup preserves the original legacy activity name', async () => {
    const draft = await query.queryDraftStudentLogs(original.student_id, studentName);
    assert.equal(draft.records[0].activity_name, originalName);
  });
  for (const [student, name, changed] of [['RESUBMIT-GRADE-EDIT', '已拆分时长-合成年级更正', { grade: '27级' }],
    ['RESUBMIT-HOURS-EDIT', '源表累计-合成时长更正', { hours: 3.5 }]]) {
    const before = await legacy(student, name);
    await check((changed.grade ? 'grade-only' : 'hours-only') + ' legacy editor save retains the source name and unknown date', async () => {
      const draft = await query.queryDraftStudentLogs(student, studentName), row = draft.records[0];
      await expect('admin', 'PATCH', '/reviews/logs/' + row.id, editorPayload(draft, row, changed));
      const saved = (await db.query('SELECT * FROM volunteer_logs WHERE id=$1', [before.id])).rows[0];
      assert.equal(saved.activity_name, name); assert.equal(saved.activity_date, null);
      assert.equal(Number(saved.hours), changed.hours || 2.5); assert.equal(saved.grade, changed.grade || '26级');
    });
  }
  await check('student publication still presents the friendly cumulative activity label', async () => {
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: '合成历史名称公示' });
    const result = await query.queryStudentLogs(original.student_id, studentName);
    assert.equal(result.records[0].activity_name, '累计时长记录');
  });
  await check('withdrawn and rejected resubmissions detect pending approved and rejected imports', async () => {
    for (const status of ['pending', 'approved', 'rejected']) for (const previous of ['withdrawn', 'rejected']) {
      const student = 'RESUBMIT-' + status + '-' + previous, { activity, row } = await withdrawn(student);
      const replacement = await imported(student, activity);
      await db.query('UPDATE volunteer_logs SET status=$2 WHERE id=$1', [replacement.id, status]);
      await db.query('UPDATE volunteer_logs SET status=$2 WHERE id=$1', [row.id, previous]);
      const response = await call('organizer', 'PATCH', '/logs/' + row.id + '/resubmit', { hours: 2.5 });
      assert([400, 409].includes(response.statusCode), response.body);
      assert.equal((await db.query('SELECT status FROM volunteer_logs WHERE id=$1', [row.id])).rows[0].status, previous);
    }
  });
  await check('resubmission checks the corrected student ID against imported records', async () => {
    const { activity, row } = await withdrawn('RESUBMIT-OLD-ID');
    await imported('RESUBMIT-CORRECTED-ID', activity);
    const response = await call('organizer', 'PATCH', '/logs/' + row.id + '/resubmit', { student_id: 'RESUBMIT-CORRECTED-ID' });
    assert([400, 409].includes(response.statusCode), response.body);
    assert.equal((await db.query('SELECT student_id FROM volunteer_logs WHERE id=$1', [row.id])).rows[0].student_id, 'RESUBMIT-OLD-ID');
  });
  await check('a valid correction excludes itself and remains distinct from an imported adjustment', async () => {
    const student = 'RESUBMIT-VALID', { activity, row } = await withdrawn(student);
    await imported(student, activity, { hours: -0.5, is_adjustment: true, adjustment_reason: '合成扣减' });
    await db.query("UPDATE volunteer_logs SET status='rejected' WHERE id=$1", [row.id]);
    const saved = await expect('organizer', 'PATCH', '/logs/' + row.id + '/resubmit', { hours: 3.5 });
    assert.equal(saved.status, 'pending'); assert.equal(Number(saved.hours), 3.5);
  });
  await check('resubmission before a concurrent import leaves only one effective record', () => competingImport(false));
  await check('import before a concurrent resubmission leaves only one effective record', () => competingImport(true));
  await check('new participant preview and submission also reject an unlinked imported duplicate', async () => {
    const student = 'RESUBMIT-FRESH', { activity } = await withdrawn(student);
    await imported(student, activity);
    const body = { activity_id: activity.id, records: [record(student)] };
    const preview = await expect('organizer', 'POST', '/logs/preview', body);
    assert.equal(preview.errors, 1);
    await expect('organizer', 'POST', '/logs', body, 400);
  });
}
main().catch(error => { checks.push({ name: 'resubmit harness', passed: false, error: error.message }); }).finally(async () => {
  fs.writeFileSync(process.env.RESUBMIT_RESULT_PATH || '/tmp/ux-resubmit-result.json', JSON.stringify(checks, null, 2));
  await app.close(); await db.pool.end();
  if (checks.some(check => !check.passed)) process.exitCode = 1;
});
