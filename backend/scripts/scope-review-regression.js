const assert = require('node:assert/strict');
const fs = require('node:fs');
const url = new URL(process.env.SCOPE_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/ux_scope_review_test');
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
process.env.DATABASE_URL = url.href;
const db = require('../src/db');
const app = require('../src/app').buildApp();
const academic = require('../src/services/academicService');
const publication = require('../src/services/publicationService');
const query = require('../src/services/queryService');
const stats = require('../src/services/statsService');
const importer = require('../src/services/importService');
const accounts = {}, checks = [], college = '计算机科学与工程学院', otherCollege = '车辆工程学院';
const call = (role, method, path, payload, extraHeaders = {}) => app.inject({ method, url: '/api/v1' + path, payload,
  headers: { authorization: 'Bearer ' + accounts[role].token, ...extraHeaders } });
async function expect(role, method, path, payload, status = 200) {
  const response = await call(role, method, path, payload);
  assert.equal(response.statusCode, status, response.body); return response.json();
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  console.log((checks.at(-1).passed ? 'PASS ' : 'FAIL ') + name);
}
const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
function eventPayload(event, changed = {}) {
  return { name: event.name, start_time: event.start_time, end_time: event.end_time, org_name: event.org_name,
    location: event.location || '', description: event.description || '', academic_year: event.academic_year || '',
    academic_term: event.academic_term || '', ...changed };
}
async function owned(role, suffix, approve = true) {
  const event = await expect(role, 'POST', '/activities', { name: '合成审核边界-' + suffix, org_name: college,
    start_time: '2026-10-14T09:00:00+08:00', end_time: '2026-10-14T12:00:00+08:00' }, 201);
  await expect(role, 'POST', '/logs', { activity_id: event.id, records: [{ student_id: 'SCOPE-' + suffix,
    student_name: '合成边界学生', college, grade: '26级', hours: 2.5 }] }, 201);
  const row = (await db.query('SELECT * FROM volunteer_logs WHERE activity_id=$1', [event.id])).rows[0];
  if (approve) await expect('admin', 'PATCH', '/logs/' + row.id + '/approve', {});
  return { event, row };
}
async function log(id) { return (await db.query('SELECT * FROM volunteer_logs WHERE id=$1', [id])).rows[0]; }
async function override(row) {
  await expect('admin', 'PATCH', '/reviews/logs/' + row.id, { academic_year: '2024-2025', academic_term: 'lower' });
}
async function profileRow(student, name, school, grade, hours, date, created) {
  return (await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,hours,activity_name,activity_date,source,status,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'imported','approved',$8) RETURNING *`,
  [student, name, school, grade, hours, '合成资料汇总-' + student + '-' + hours, date, created])).rows[0];
}
const inputRow = (student, extra = {}) => ({ student_id: student, student_name: '合成导入长度学生', college, grade: '26级',
  activity_name: '合成长度活动-' + student, activity_date: '2026-10-14', hours: -0.5, is_adjustment: true,
  adjustment_reason: '合成扣减说明', activity_period: '', status: 'ok', problem_confirmed: true, row: 17, ...extra });
async function workbook(row) {
  const book = new (require('exceljs').Workbook)();
  book.addWorksheet('合成长度数据').addRows([
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '记录类型', '调整说明', '活动期间'],
    [row.student_id, row.student_name, row.college, row.grade, row.activity_name, row.activity_date, row.hours,
      row.is_adjustment ? '调整' : '普通', row.adjustment_reason, row.activity_period],
  ]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function upload(row) {
  const boundary = 'ScopeReviewBoundary', buffer = await workbook(row);
  const payload = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="synthetic-limits.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'),
    buffer, Buffer.from('\r\n--' + boundary + '--\r\n')]);
  const response = await call('admin', 'POST', '/import/preview', payload, { 'content-type': 'multipart/form-data; boundary=' + boundary });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function main() {
  await require('../src/db/ensureSchema').ensureSchema();
  const hash = await require('bcrypt').hash(process.env.SCOPE_TEST_PASSWORD, 12);
  for (const role of ['admin', 'organizer', 'college_admin']) {
    accounts[role] = (await db.query('INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['scope-' + role, hash, '合成边界账号', role, college])).rows[0];
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'scope-' + role, password: process.env.SCOPE_TEST_PASSWORD } });
    assert.equal(login.statusCode, 200); accounts[role].token = login.json().access_token;
  }
  for (const role of ['organizer', 'college_admin']) await check(role + ' cannot move approved activity hours to another year or term', async () => {
    const { event, row } = await owned(role, role);
    const response = await call(role, 'PUT', '/activities/' + event.id, eventPayload(event, {
      start_time: '2027-10-14T09:00:00+08:00', end_time: '2027-10-14T12:00:00+08:00', academic_year: '2027-2028', academic_term: 'vacation' }));
    assert.equal(response.statusCode, 403, response.body);
    const saved = await log(row.id); assert.equal(saved.status, 'approved'); assert.equal(day(saved.activity_date), '2026-10-14');
    assert.equal(day((await db.query('SELECT start_time FROM activities WHERE id=$1', [event.id])).rows[0].start_time), '2026-10-14');
  });
  await check('description-only activity saves preserve office-assigned record periods', async () => {
    for (const role of ['organizer', 'admin']) {
      const { event, row } = await owned('organizer', 'description-' + role); await override(row);
      await expect(role, 'PUT', '/activities/' + event.id, eventPayload(event, { description: '合成说明更正' }));
      const saved = await log(row.id); assert.equal(saved.academic_year, '2024-2025'); assert.equal(saved.academic_term, 'lower');
    }
  });
  await check('office activity year changes preserve unrelated per-record term overrides', async () => {
    const { event, row } = await owned('organizer', 'office-year'); await override(row);
    await expect('admin', 'PUT', '/activities/' + event.id, eventPayload(event, { academic_year: '2027-2028' }));
    const saved = await log(row.id); assert.equal(saved.academic_year, '2027-2028');
    assert.equal(saved.academic_term, 'lower'); assert.equal(saved.status, 'approved');
  });
  await check('same-day clock changes do not overwrite reviewed record classification', async () => {
    const { event, row } = await owned('organizer', 'same-day'); await override(row);
    await expect('organizer', 'PUT', '/activities/' + event.id, eventPayload(event, { start_time: '2026-10-14T10:00:00+08:00' }));
    const saved = await log(row.id); assert.equal(saved.academic_year, '2024-2025'); assert.equal(saved.academic_term, 'lower');
  });
  await check('an approval committed during activity editing is protected after the row lock', async () => {
    const { event, row } = await owned('organizer', 'approval-race', false), blocker = await db.pool.connect();
    let editing;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM volunteer_logs WHERE id=$1 FOR UPDATE', [row.id]);
      editing = call('organizer', 'PUT', '/activities/' + event.id, eventPayload(event, { start_time: '2027-10-14T09:00:00+08:00', end_time: '2027-10-14T12:00:00+08:00' }));
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%volunteer_logs%'")).rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert(waiting, 'activity edit did not reach the controlled log lock');
      await blocker.query("UPDATE volunteer_logs SET status='approved',reviewed_by=$2,reviewed_at=now() WHERE id=$1", [row.id, accounts.admin.id]);
      await blocker.query('COMMIT');
      const response = await editing; assert.equal(response.statusCode, 403, response.body);
      assert.equal(day((await log(row.id)).activity_date), '2026-10-14');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (editing) await editing; }
  });
  await profileRow('PROFILE-A', '合成资料甲', college, null, 2, '2026-09-10', '2026-09-11T00:00:00Z');
  await profileRow('PROFILE-A', '合成资料甲', college, '91级', 3, '2026-10-13', '2026-10-14T00:00:00Z');
  await profileRow('PROFILE-B', '合成资料乙', college, '91级', 4, '2026-10-12', '2026-10-13T00:00:00Z');
  await profileRow('PROFILE-C', '合成资料丙', college, '92级', 2, '2026-09-10', '2026-09-11T00:00:00Z');
  await profileRow('PROFILE-C', '合成资料丙', '', '   ', 3, '2026-10-13', '2026-10-14T00:00:00Z');
  await profileRow('PROFILE-D', '合成资料丁', college, '93级', 2, '2026-09-10', '2026-09-11T00:00:00Z');
  await profileRow('PROFILE-D', '合成资料丁', otherCollege, null, 3, '2026-10-13', '2026-10-14T00:00:00Z');
  for (const [name, hours] of [['合成同号甲', 1], ['合成同号乙', 2]]) await profileRow('PROFILE-SAME', name, college, '94级', hours, '2026-10-14', '2026-10-14T00:00:00Z');
  const state = await publication.publish(accounts.admin.id, { publication_month: '2026-10', label: '合成资料排名公示' });
  await check('a published 5-hour student ranks above a 4-hour peer despite an earlier missing grade', async () => {
    const result = await query.queryStudentLogs('PROFILE-A', '合成资料甲');
    assert.equal(result.total_hours, 5); assert.equal(result.grade, '91级');
    const year = result.academic_summaries.find(row => row.academic_year === '2026-2027');
    assert.equal(year.rank, 1); assert.equal(year.total_students, 2);
  });
  await check('draft and office year summaries use the same full student total and rank', async () => {
    const summary = await academic.getSummary({ academic_year: '2026-2027', college, grade: '91级', student_id: 'PROFILE-A' });
    assert.equal(summary.rows.length, 1); assert.equal(summary.rows[0].total_hours, 5); assert.equal(summary.rows[0].rank, 1);
    const draft = await query.queryDraftStudentLogs('PROFILE-A', '合成资料甲');
    assert.equal(draft.total_hours, 5); assert.equal(draft.grade, '91级'); assert.equal(draft.academic_summaries[0].rank, 1);
  });
  await check('all-grade published and office summaries contain one row per student identity', async () => {
    const published = publication.summary(state, { academic_year: '2026-2027', student_id: 'PROFILE-A' });
    const draft = await academic.getSummary({ academic_year: '2026-2027', student_id: 'PROFILE-A' });
    assert.equal(published.rows.length, 1); assert.equal(draft.rows.length, 1); assert.equal(published.rows[0].total_hours, 5);
  });
  await check('newer blank metadata falls back to the latest nonempty approved profile', async () => {
    const result = await query.queryStudentLogs('PROFILE-C', '合成资料丙');
    assert.equal(result.college, college); assert.equal(result.grade, '92级'); assert.equal(result.total_hours, 5);
    const draft = await query.queryDraftStudentLogs('PROFILE-C', '合成资料丙');
    assert.equal(draft.college, college); assert.equal(draft.grade, '92级');
  });
  await check('college changes merge complete student hours in rankings and college statistics', async () => {
    const result = await query.queryStudentLogs('PROFILE-D', '合成资料丁');
    assert.equal(result.college, otherCollege); assert.equal(result.grade, '93级');
    const summary = await academic.getSummary({ academic_year: '2026-2027', college: otherCollege, grade: '93级' });
    assert.equal(summary.rows[0].total_hours, 5);
    const rankings = await stats.getRankings(), rows = rankings.students.filter(row => row.student_id === 'PROFILE-D');
    assert.equal(rows.length, 1); assert.equal(Number(rows[0].total_hours), 5);
    assert.equal(Number(rankings.colleges.find(row => row.college === otherCollege).total_hours), 5);
  });
  await check('matching student IDs with different names remain separate identities', async () => {
    const rows = publication.summary(state, { academic_year: '2026-2027', grade: '94级', student_id: 'PROFILE-SAME' }).rows;
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.total_hours).sort(), [1, 2]);
  });
  await check('college-scoped lookup retains record boundaries and avoids a rank for a different total', async () => {
    const scoped = await query.queryDraftStudentLogs('PROFILE-D', '合成资料丁', otherCollege);
    assert.equal(scoped.records.length, 1); assert.equal(scoped.total_hours, 3);
    assert.equal(scoped.academic_summaries[0].rank, null);
    const permitted = (await db.query("SELECT id FROM volunteer_logs WHERE student_id='PROFILE-D' AND college=$1", [otherCollege])).rows;
    assert.deepEqual(scoped.records.map(row => row.id), permitted.map(row => row.id));
  });
  await check('pending metadata cannot change an approved or frozen student profile', async () => {
    const row = await profileRow('PROFILE-A', '合成资料甲', otherCollege, '99级', 1, '2026-10-14', '2026-10-15T00:00:00Z');
    await db.query("UPDATE volunteer_logs SET status='pending' WHERE id=$1", [row.id]);
    try {
      const frozen = await query.queryStudentLogs('PROFILE-A', '合成资料甲');
      assert.equal(frozen.grade, '91级'); assert.equal(frozen.college, college);
      const draft = await academic.getSummary({ academic_year: '2026-2027', college, grade: '91级', student_id: 'PROFILE-A' });
      assert.equal(draft.rows[0].total_hours, 5);
    } finally { await db.query("UPDATE volunteer_logs SET status='withdrawn' WHERE id=$1", [row.id]); }
  });
  await check('an older split snapshot is ranked from its frozen records without rewriting the batch', async () => {
    const expr = academic.expressions();
    const oldTotals = (await db.query(`SELECT ${expr.year} AS academic_year,student_id,student_name,college,grade,
      COALESCE(sum(hours) FILTER(WHERE ${expr.term}='upper'),0) AS upper_hours,
      COALESCE(sum(hours) FILTER(WHERE ${expr.term}='lower'),0) AS lower_hours,
      COALESCE(sum(hours) FILTER(WHERE ${expr.term}='vacation'),0) AS vacation_hours,
      COALESCE(sum(hours) FILTER(WHERE ${expr.term}='unassigned'),0) AS unassigned_hours,sum(hours) AS total_hours
      FROM volunteer_logs l WHERE status='approved' GROUP BY ${expr.year},student_id,student_name,college,grade
      ORDER BY total_hours DESC,student_id,student_name,college,grade`)).rows.map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field, field.endsWith('_hours') ? Number(value) : value])));
    await db.query("UPDATE publication_batches SET snapshot=jsonb_set(snapshot,'{totals}',$2::jsonb) WHERE id=$1", [state.batch.id, JSON.stringify(oldTotals)]);
    const digest = (await db.query('SELECT md5(snapshot::text) AS digest FROM publication_batches WHERE id=$1', [state.batch.id])).rows[0].digest;
    delete require.cache[require.resolve('../src/services/publicationService')];
    const fresh = require('../src/services/publicationService'), frozen = await fresh.current();
    const selected = fresh.summary(frozen, { academic_year: '2026-2027', college, grade: '91级', student_id: 'PROFILE-A' });
    assert.equal(selected.rows[0].total_hours, 5); assert.equal(selected.rows[0].rank, 1);
    assert.equal((await db.query('SELECT md5(snapshot::text) AS digest FROM publication_batches WHERE id=$1', [state.batch.id])).rows[0].digest, digest);
  });
  await check('pending activity date corrections preserve unrelated office overrides', async () => {
    const { event, row } = await owned('organizer', 'pending-date', false); await override(row);
    try {
      await expect('organizer', 'PUT', '/activities/' + event.id, eventPayload(event, { start_time: '2026-10-15T09:00:00+08:00', end_time: '2026-10-15T12:00:00+08:00' }));
      const saved = await log(row.id); assert.equal(day(saved.activity_date), '2026-10-15');
      assert.equal(saved.academic_year, '2024-2025'); assert.equal(saved.academic_term, 'lower');
    } finally { await expect('admin', 'PATCH', '/logs/' + row.id + '/approve', {}); }
  });
  for (const [field, limit, title] of [['adjustment_reason', 512, '调整说明'], ['activity_period', 64, '活动期间']]) {
    await check('Excel preview rejects overlong ' + field + ' with its row and field issue', async () => {
      const row = inputRow('LIMIT-PREVIEW-' + limit, { [field]: '文'.repeat(limit + 1) });
      const preview = await importer.parsePreview(await workbook(row));
      assert.equal(preview.rows[0].row, 2); assert.equal(preview.rows[0].can_import, false);
      assert(preview.rows[0].issues.some(issue => issue.code === field + '_too_long' && issue.level === 'error' && issue.message.includes(title)));
    });
    await check('prepare rejects overlong ' + field + ' before producing a confirmation record', async () => {
      await assert.rejects(importer.prepareImportRow(inputRow('LIMIT-PREPARE-' + limit, { [field]: '文'.repeat(limit + 1), row: 23 }), {}),
        error => error.code === 'IMPORT_VALIDATION' && error.message.includes('23') && error.message.includes(title));
    });
  }
  await check('multipart import cannot produce a confirmation summary for a 600-character reason', async () => {
    const preview = await upload(inputRow('LIMIT-HTTP', { adjustment_reason: '理'.repeat(600) }));
    const response = await call('admin', 'POST', '/import/prepare', { preview_id: preview.preview_id, dataset_key: 'scope-text-limit', note: '合成长度库' });
    assert.equal(response.statusCode, 400, response.body); assert.match(response.json().message, /第\s*2\s*行/);
  });
  await check('direct confirmation rejects an invalid mixed batch as validation without partial writes', async () => {
    const before = (await db.query('SELECT (SELECT count(*) FROM volunteer_logs) AS logs,(SELECT count(*) FROM import_batches) AS batches')).rows[0];
    await assert.rejects(importer.confirmImport([inputRow('LIMIT-MIX-VALID'), inputRow('LIMIT-MIX-INVALID', { adjustment_reason: '理'.repeat(600), row: 29 })],
      accounts.admin.id, '合成拒绝整批'), error => error.code === 'IMPORT_VALIDATION' && error.message.includes('29'));
    assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM volunteer_logs) AS logs,(SELECT count(*) FROM import_batches) AS batches')).rows[0], before);
  });
  for (const [suffix, character] of [['ASCII', 'x'], ['UNICODE', '🙂']]) await check('exact text limits preserve all characters in a real ' + suffix + ' import', async () => {
    const row = inputRow('LIMIT-BOUNDARY-' + suffix, { adjustment_reason: character.repeat(512), activity_period: character.repeat(64) });
    const preview = await importer.parsePreview(await workbook(row)); assert.equal(preview.rows[0].can_import, true);
    const result = await importer.confirmImport([row], accounts.admin.id, '合成边界-' + suffix); assert.equal(result.count, 1);
    const saved = (await db.query('SELECT adjustment_reason,activity_period,char_length(adjustment_reason) AS reason_length,char_length(activity_period) AS period_length FROM volunteer_logs WHERE import_batch_id=$1', [result.batch_id])).rows[0];
    assert.equal(saved.adjustment_reason, row.adjustment_reason); assert.equal(saved.activity_period, row.activity_period);
    assert.equal(saved.reason_length, 512); assert.equal(saved.period_length, 64);
  });
}
main().catch(error => { checks.push({ name: 'scope harness', passed: false, error: error.message }); }).finally(async () => {
  fs.writeFileSync(process.env.SCOPE_RESULT_PATH || '/tmp/ux-scope-result.json', JSON.stringify(checks, null, 2));
  await app.close(); await db.pool.end();
  if (checks.some(check => !check.passed)) process.exitCode = 1;
});
