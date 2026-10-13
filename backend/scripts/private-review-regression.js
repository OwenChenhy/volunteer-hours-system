const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = new URL(process.env.PRIVATE_REVIEW_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/ux_private_review_test');
assert(['localhost', '127.0.0.1'].includes(url.hostname));
process.env.DATABASE_URL = url.href;
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const db = require('../src/db');
const { buildApp } = require('../src/app');
const publication = require('../src/services/publicationService');
const query = require('../src/services/queryService');
const importer = require('../src/services/importService');
const college = '计算机科学与工程学院';
const accounts = {}, checks = [];
const app = buildApp();

async function call(role, method, route, payload) {
  return app.inject({ method, url: '/api/v1' + route, payload,
    headers: { authorization: 'Bearer ' + accounts[role].token } });
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  console.log((checks.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}
async function workbookRow(student, options = {}) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('26级');
  sheet.addRow(['学号', '姓名', '学院', '年级', '活动名称', '活动日期', options.cumulative ? '累计服务时长' : '服务时长（小时）', '学年', '归属阶段', '活动期间']);
  sheet.addRow([student, '合成审查学生', college, '26级', '合成审查活动', options.date || '', 2.5, options.year || '', options.term || '', options.period || '']);
  const preview = await importer.parsePreview(Buffer.from(await book.xlsx.writeBuffer()));
  assert.equal(preview.rows.length, 1);
  return { ...preview.rows[0], problem_confirmed: true };
}
async function prepare(student, input, defaults = {}) {
  return (await importer.prepareImportRow(await workbookRow(student, input), { dataset_key: 'private-year-fixture', ...defaults })).record;
}
async function archived(student, suffix = '') {
  const batch = (await db.query('INSERT INTO import_batches(filename,imported_by,record_count,note,dataset_key) VALUES($1,$2,1,$3,$4) RETURNING id',
    ['private-' + student + suffix + '.xlsx', accounts.admin.id, '合成审查批次', 'private-' + student + suffix])).rows[0];
  return (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status,import_batch_id,lifecycle_previous_status)
    VALUES($1,'合成恢复学生',$2,'26级','合成并发恢复活动','2026-10-14',2.5,'imported','voided',$3,'approved') RETURNING *`, [student, college, batch.id])).rows[0];
}
async function waitingForWriters(count) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = (await db.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
      AND state='active' AND wait_event_type='Lock'
      AND (query LIKE '%UPDATE volunteer_logs%' OR query LIKE '%INSERT INTO volunteer_logs%' OR query LIKE '%pg_advisory_xact_lock(927641)%')`)).rows[0].count;
    if (waiting >= count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('concurrent writers did not reach the controlled lock barrier');
}
// A real table lock permits both old duplicate SELECTs but pauses their writes.
// With the fix, the second operation waits for the shared transaction lock instead.
async function withPausedWrites(action) {
  const blocker = await db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE volunteer_logs IN SHARE MODE');
    return await action(async () => blocker.query('COMMIT'));
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
}
async function effective(student) {
  return (await db.query("SELECT count(*)::int AS count,COALESCE(sum(hours),0) AS hours FROM volunteer_logs WHERE student_id=$1 AND status IN ('pending','approved','rejected')", [student])).rows[0];
}

async function main() {
  await require('../src/db/ensureSchema').ensureSchema();
  const hash = await bcrypt.hash(process.env.PRIVATE_REVIEW_TEST_PASSWORD, 12);
  for (const role of ['admin', 'data_admin']) {
    accounts[role] = (await db.query('INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['private-' + role, hash, '合成审查-' + role, role, college])).rows[0];
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'private-' + role, password: process.env.PRIVATE_REVIEW_TEST_PASSWORD } });
    assert.equal(login.statusCode, 200, login.body); accounts[role].token = login.json().access_token;
  }
  await check('verification results are marked read-only while ID results expose the latest draft', async () => {
    const row = (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status)
      VALUES('PRIVATE-LOOKUP','合成查询学生',$1,'26级','合成公示活动','2026-10-14',2.5,'imported','approved') RETURNING id`, [college])).rows[0];
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: '合成审查公示' });
    const published = await query.queryStudentLogs('PRIVATE-LOOKUP', '合成查询学生');
    await db.query('UPDATE volunteer_logs SET hours=4.5 WHERE id=$1', [row.id]);
    const byCode = await call('admin', 'POST', '/admin-search', { mode: 'verification_code', value: published.verification_code });
    assert.equal(byCode.statusCode, 200); assert.equal(byCode.json().matches[0].total_hours, 2.5);
    assert.equal(byCode.json().query_read_only, true);
    const byId = await call('admin', 'POST', '/admin-search', { mode: 'student_id', value: 'PRIVATE-LOOKUP' });
    assert.equal(byId.json().query_read_only, false); assert.equal(byId.json().matches[0].total_hours, 4.5);
  });
  await check('missing date and inferred legacy year are reclassified after a default date', async () => {
    const row = await prepare('PRIVATE-YEAR-1', {}, { default_activity_date: '2026-10-13' });
    assert.equal(row.activity_date, '2026-10-13'); assert.equal(row.academic_year, '2026-2027'); assert.equal(row.academic_term, 'upper');
  });
  await check('invalid February date does not retain its preview year after October replacement', async () => {
    const row = await prepare('PRIVATE-YEAR-2', { date: '2026-02-30' }, { default_activity_date: '2026-10-13' });
    assert.equal(row.activity_date, '2026-10-13'); assert.equal(row.academic_year, '2026-2027'); assert.equal(row.academic_term, 'upper');
  });
  await check('a valid date without an explicit year still determines the academic year', async () => {
    const row = await prepare('PRIVATE-YEAR-3', { date: '2026-10-13' });
    assert.equal(row.academic_year, '2026-2027');
  });
  await check('an explicitly supplied academic year is preserved', async () => {
    const row = await prepare('PRIVATE-YEAR-4', { year: '2025-2026' }, { default_activity_date: '2026-10-13' });
    assert.equal(row.academic_year, '2025-2026');
  });
  await check('the administrator default academic year keeps its existing priority', async () => {
    const row = await prepare('PRIVATE-YEAR-5', { year: '2025-2026' }, { default_activity_date: '2026-10-13', default_academic_year: '2027-2028' });
    assert.equal(row.academic_year, '2027-2028');
  });
  await check('an explicit year in the activity period is preserved', async () => {
    const row = await prepare('PRIVATE-YEAR-6', { period: '2025-2026学年上半年' }, { default_activity_date: '2026-10-13' });
    assert.equal(row.academic_year, '2025-2026');
  });
  await check('an invalid explicitly supplied year remains a validation error', async () => {
    await assert.rejects(() => prepare('PRIVATE-YEAR-7', { date: '2026-10-13', year: '2026-2028' }), { code: 'IMPORT_VALIDATION' });
  });
  await check('a cumulative row keeps its unassigned term after date completion', async () => {
    const row = await prepare('PRIVATE-YEAR-8', { cumulative: true }, { default_activity_date: '2026-10-13' });
    assert.equal(row.academic_year, '2026-2027'); assert.equal(row.academic_term, 'unassigned');
  });
  await check('two reviewers cannot restore two histories with the same import identity', async () => {
    const student = 'PRIVATE-RESTORE-PAIR';
    const first = await archived(student, '-a'), second = await archived(student, '-b');
    const responses = await withPausedWrites(async release => {
      const one = call('admin', 'POST', '/logs/' + first.id + '/restore', { reason: '合成并发恢复A' }).then(response => response);
      await waitingForWriters(1);
      const two = call('data_admin', 'POST', '/logs/' + second.id + '/restore', { reason: '合成并发恢复B' }).then(response => response);
      try { await waitingForWriters(2); } finally { await release(); }
      return Promise.all([one, two]);
    });
    const current = await effective(student);
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409], JSON.stringify({ statuses: responses.map(response => response.statusCode), effective: current }));
    assert.equal(current.count, 1); assert.equal(Number(current.hours), 2.5);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM review_notes WHERE log_id=ANY($1::uuid[]) AND action='restore'", [[first.id, second.id]])).rows[0].count, 1);
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: '合成恢复公示' });
    assert.equal((await query.queryStudentLogs(student, '合成恢复学生')).total_hours, 2.5);
  });
  await check('restoration and import confirmation share the same duplicate protection', async () => {
    const student = 'PRIVATE-RESTORE-IMPORT', old = await archived(student);
    const outcomes = await withPausedWrites(async release => {
      const restore = call('admin', 'POST', '/logs/' + old.id + '/restore', { reason: '合成恢复与导入' }).then(response => response);
      await waitingForWriters(1);
      const imported = importer.confirmImport([{ ...old, status: 'ok', problem_confirmed: true }], accounts.data_admin.id, '合成并发导入', 'private-concurrent.xlsx');
      try { await waitingForWriters(2); } finally { await release(); }
      return Promise.all([restore, imported]);
    });
    assert.equal(outcomes[0].statusCode, 200);
    const current = await effective(student);
    assert.equal(current.count, 1, JSON.stringify({ imported: outcomes[1].count, effective: current }));
    assert.equal(outcomes[1].count, 0); assert.equal(outcomes[1].skipped_duplicate_count, 1);
  });
}
main().catch(error => { checks.push({ name: 'private review harness', passed: false, error: error.message }); }).finally(async () => {
  fs.writeFileSync(process.env.PRIVATE_REVIEW_RESULT_PATH || '/tmp/ux-private-review-result.json', JSON.stringify(checks, null, 2));
  await app.close(); await db.pool.end();
  if (checks.some(check => !check.passed)) process.exitCode = 1;
});
