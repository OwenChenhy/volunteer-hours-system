const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const url = new URL(process.env.REVIEW_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/ux_review_test');
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
const results = [], accounts = {};
const app = buildApp();

async function call(role, method, route, payload, expected = 200) {
  const response = await app.inject({ method, url: '/api/v1' + route, payload,
    headers: { authorization: 'Bearer ' + accounts[role].token } });
  assert.equal(response.statusCode, expected, response.body);
  return response.json();
}

async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
  console.log((results.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}

async function log(student, status = 'approved', extra = {}) {
  const activity = (await db.query(`INSERT INTO activities(name,start_time,end_time,created_by)
    VALUES($1,'2026-10-13T09:00:00+08:00','2026-10-13T12:00:00+08:00',$2) RETURNING id`, ['Review activity ' + student, accounts.admin.id])).rows[0];
  return (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_id,activity_name,activity_date,hours,source,status,submitted_by)
    VALUES($1,$2,$3,'26级',$4,$5,'2026-10-13',2.5,'online',$6,$7) RETURNING *`,
    [student, 'Review ' + student, extra.college || college, activity.id, 'Review activity ' + student, status, accounts.admin.id])).rows[0];
}

// Hold the same activity -> log locks as a lifecycle operation. The editor must wait,
// then validate the committed row, rather than the snapshot it read before waiting.
async function editAfterConcurrentChange(row, changeSql, changeParams, role, patch, expected) {
  const blocker = await db.pool.connect();
  let edit;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [row.activity_id]);
    await blocker.query('SELECT id FROM volunteer_logs WHERE id=$1 FOR UPDATE', [row.id]);
    edit = app.inject({ method: 'PATCH', url: '/api/v1/reviews/logs/' + row.id, payload: patch,
      headers: { authorization: 'Bearer ' + accounts[role].token } }).then(response => response);
    let waiting = false;
    for (let i = 0; i < 150; i++) {
      const peers = await db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%FROM activities%FOR UPDATE%'`);
      if (peers.rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(waiting, 'editor did not reach the held activity lock');
    await blocker.query(changeSql, changeParams);
    await blocker.query('COMMIT');
    const response = await edit;
    assert.equal(response.statusCode, expected, response.body);
    return response.json();
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    if (edit) await edit;
  }
}

async function workbook(rows) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Review fixture');
  sheet.addRow(['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）']);
  for (const row of rows) sheet.addRow([row.student_id, row.student_name, college, '26级', row.activity_name, row.activity_date, Number(row.hours)]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function preview(rows) {
  const boundary = 'review-' + crypto.randomUUID();
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="review-fixture.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), await workbook(rows), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response = await app.inject({ method: 'POST', url: '/api/v1/import/preview', payload,
    headers: { authorization: 'Bearer ' + accounts.admin.token, 'content-type': 'multipart/form-data; boundary=' + boundary } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function main() {
  await require('../src/db/ensureSchema').ensureSchema();
  const hash = await bcrypt.hash(process.env.REVIEW_TEST_PASSWORD, 12);
  for (const role of ['admin', 'college_admin']) {
    accounts[role] = (await db.query('INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['review-' + role, hash, 'Review ' + role, role, college])).rows[0];
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'review-' + role, password: process.env.REVIEW_TEST_PASSWORD } });
    assert.equal(response.statusCode, 200, response.body); accounts[role].token = response.json().access_token;
  }
  await check('public verification code keeps its published total while ID and name use the draft', async () => {
    const row = await log('REVIEW-CODE');
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: 'Synthetic review publication' });
    const original = await query.queryStudentLogs(row.student_id, row.student_name);
    await db.query('UPDATE volunteer_logs SET hours=4.5 WHERE id=$1', [row.id]);
    const byCode = await call('admin', 'POST', '/admin-search', { mode: 'verification_code', value: original.verification_code.toLowerCase() });
    assert.equal(byCode.total_matches, 1);
    assert.equal(byCode.matches[0].verification_code, original.verification_code);
    assert.equal(byCode.matches[0].total_hours, 2.5);
    assert.equal(byCode.matches[0].data_version.batch_id, original.data_version.batch_id);
    for (const mode of ['student_id', 'student_name']) {
      const draft = await call('admin', 'POST', '/admin-search', { mode, value: row[mode] });
      assert.equal(draft.matches[0].total_hours, 4.5);
    }
    await call('college_admin', 'POST', '/admin-search', { mode: 'verification_code', value: original.verification_code }, 403);
    await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: 'Synthetic corrected publication' });
    assert.equal((await call('admin', 'POST', '/admin-search', { mode: 'verification_code', value: original.verification_code })).total_matches, 0);
    const corrected = await query.queryStudentLogs(row.student_id, row.student_name);
    assert.equal((await call('admin', 'POST', '/admin-search', { mode: 'verification_code', value: corrected.verification_code })).matches[0].total_hours, 4.5);
  });
  await check('concurrent withdrawal or voiding prevents an edit and creates no review note', async () => {
    for (const status of ['voided', 'withdrawn']) {
      const row = await log('REVIEW-' + status);
      await editAfterConcurrentChange(row, 'UPDATE volunteer_logs SET status=$2 WHERE id=$1', [row.id, status], 'admin', { hours: 7, note: 'Synthetic concurrency test' }, 409);
      assert.equal(Number((await db.query('SELECT hours FROM volunteer_logs WHERE id=$1', [row.id])).rows[0].hours), 2.5);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM review_notes WHERE log_id=$1', [row.id])).rows[0].count, 0);
    }
  });
  await check('date validation uses the freshly locked row and releases rejected transactions', async () => {
    const row = await log('REVIEW-DATE');
    await db.query('UPDATE volunteer_logs SET activity_date=NULL WHERE id=$1', [row.id]);
    await editAfterConcurrentChange(row, "UPDATE volunteer_logs SET activity_date='2026-10-13' WHERE id=$1", [row.id], 'admin', { activity_date: null }, 400);
    assert.equal((await db.query('SELECT activity_date FROM volunteer_logs WHERE id=$1', [row.id])).rows[0].activity_date, '2026-10-13');
    await call('admin', 'PATCH', '/reviews/logs/' + row.id, { hours: 3.5 });
    await call('college_admin', 'PATCH', '/reviews/logs/' + row.id, { hours: 6 }, 403);
  });
  await check('review history records the latest committed value before editing', async () => {
    const row = await log('REVIEW-HISTORY');
    await editAfterConcurrentChange(row, 'UPDATE volunteer_logs SET hours=3.5 WHERE id=$1', [row.id], 'admin', { hours: 5.5 }, 200);
    const note = (await db.query('SELECT detail FROM review_notes WHERE log_id=$1', [row.id])).rows[0];
    assert.equal(Number(note.detail.before.hours), 3.5);
  });
  const duplicates = [];
  for (const status of ['pending', 'rejected', 'approved']) duplicates.push(await log('REVIEW-DUP-' + status, status));
  await check('preview warns about pending and rejected duplicates', async () => {
    const result = await preview(duplicates);
    assert(result.rows.every(row => row.issues.some(issue => issue.code === 'duplicate_record')));
  });
  await check('prepare excludes every effective duplicate from the confirmation totals', async () => {
    const unique = { student_id: 'REVIEW-UNIQUE', student_name: 'Review Unique', activity_name: 'Review unique activity', activity_date: '2026-10-13', hours: 1 };
    const result = await preview([...duplicates, unique]);
    const prepared = await call('admin', 'POST', '/import/prepare', { preview_id: result.preview_id, dataset_key: 'review-prepare', note: 'Synthetic review import',
      confirmed_row_keys: result.rows.map(row => `${row.sheet || ''}:${row.row || ''}:${row.student_id || ''}:${row.student_name || ''}`) });
    assert.equal(prepared.new_count, 1); assert.equal(prepared.skipped_count, 3);
    const imported = await call('admin', 'POST', '/import/confirm', { preview_id: result.preview_id, confirmation_id: prepared.confirmation_id });
    assert.equal(imported.count, 1); assert.equal(imported.skipped_duplicate_count, 3);
  });
  await check('confirm deduplicates pending and rejected records while permitting inactive history', async () => {
    const inactive = [await log('REVIEW-INACTIVE-1', 'voided'), await log('REVIEW-INACTIVE-2', 'withdrawn')];
    const result = await importer.confirmImport([...duplicates, ...inactive].map(row => ({ ...row, status: 'ok', problem_confirmed: true })), accounts.admin.id, 'Synthetic service import');
    assert.equal(result.count, 2); assert.equal(result.skipped_duplicate_count, 3);
    for (const row of duplicates) assert.equal((await db.query('SELECT count(*)::int AS count FROM volunteer_logs WHERE student_id=$1', [row.student_id])).rows[0].count, 1);
  });
  await check('confirm rechecks a pending submission committed after initial normalization', async () => {
    const row = { student_id: 'REVIEW-LATE', student_name: 'Review Late', college, grade: '26级', activity_name: 'Review late activity', activity_date: '2026-10-13', hours: 2, status: 'ok', problem_confirmed: true };
    const originalQuery = db.query;
    let inserted = false;
    db.query = async (sql, params) => {
      const result = await originalQuery(sql, params);
      if (!inserted && /SELECT 1 FROM volunteer_logs/.test(sql) && params?.[0] === row.student_id) {
        inserted = true;
        await originalQuery(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,'online','pending')`, [row.student_id, row.student_name, college, row.grade, row.activity_name, row.activity_date, row.hours]);
      }
      return result;
    };
    try {
      const result = await importer.confirmImport([row], accounts.admin.id, 'Synthetic late import');
      assert(inserted); assert.equal(result.count, 0); assert.equal(result.skipped_duplicate_count, 1);
    } finally { db.query = originalQuery; }
  });
}

main().catch(error => { results.push({ name: 'review harness', passed: false, error: error.message }); }).finally(async () => {
  fs.writeFileSync(process.env.REVIEW_RESULT_PATH || '/tmp/ux-review-result.json', JSON.stringify(results, null, 2));
  await app.close(); await db.pool.end();
  if (results.some(result => !result.passed)) process.exitCode = 1;
});
