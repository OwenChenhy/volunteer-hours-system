const assert = require('assert');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const testUrl = process.env.ACADEMIC_TEST_DATABASE_URL;
if (testUrl) {
  const parsed = new URL(testUrl);
  assert.strictEqual(parsed.pathname, '/academic_test', 'integration must target the dedicated test database');
  assert(['127.0.0.1', 'localhost'].includes(parsed.hostname), 'integration must target the server-local test database');
  process.env.DATABASE_URL = testUrl;
}
const db = require('../src/db');
const academic = require('../src/services/academicService');
const { parsePreview, confirmImport } = require('../src/services/importService');
const { queryStudentLogs, getDataVersion } = require('../src/services/queryService');

async function workbook(rows, sheet = '25级') {
  const book = new ExcelJS.Workbook();
  book.addWorksheet(sheet).addRows([['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '学年', '归属阶段', '录入类型', '调整说明'], ...rows]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function main() {
  assert.deepStrictEqual(academic.classify({ activity_date: '2026-09-01' }), { academic_year: '2026-2027', academic_term: 'upper', term_label: '上半年' });
  assert.strictEqual(academic.classify({ activity_date: '2026-08-31' }).academic_year, '2025-2026');
  assert.strictEqual(academic.classify({ activity_date: '2026-02-15' }).academic_term, 'vacation');
  assert.strictEqual(academic.classify({ activity_date: '2026-07-15' }).academic_term, 'vacation');
  assert.strictEqual(academic.classify({ activity_date: '2026-04-01' }).academic_term, 'lower');
  assert.strictEqual(academic.classify({ activity_date: '2026-04-01', activity_period: '暑期补录' }).academic_term, 'vacation');
  assert.strictEqual(academic.classify({ activity_date: '2026-04-01', activity_name: '累计未拆分' }).academic_term, 'unassigned');
  assert(!academic.validDate('2026-02-30')); assert(academic.validDate('2028-02-29'));
  assert(!academic.validYear('2025-2027')); assert(academic.validYear('2025-2026'));
  const summed = academic.summarize([{ activity_date: '2025-10-01', hours: 0.1 }, { activity_date: '2026-04-01', hours: 0.2 }, { activity_date: '2026-08-01', hours: -0.1 }])[0];
  assert.strictEqual(summed.total_hours, 0.2); assert.strictEqual(summed.vacation_hours, -0.1);
  process.env.ACADEMIC_VACATION_MONTHS = '1,2';
  assert.throws(() => academic.rules(), /重叠/);
  delete process.env.ACADEMIC_VACATION_MONTHS;
  console.log(JSON.stringify({ academic_rules: 'passed', date_boundaries: 'passed', signed_tenths: 'passed' }));
  if (!testUrl) { await db.pool.end(); return; }

  assert.strictEqual((await db.query('SELECT current_database() AS name')).rows[0].name, 'academic_test');
  await db.query("INSERT INTO users(id, username, password_hash, real_name, role, org_name) VALUES ('00000000-0000-0000-0000-000000000001', 'academic-test-admin', 'not-a-login-credential', '测试管理员', 'admin', '校青协') ON CONFLICT DO NOTHING");
  const adminId = '00000000-0000-0000-0000-000000000001';
  const college = '计算机科学与工程学院';
  const buffer = await workbook([
    ['ACADEMIC-001', '同名样例', college, '', '秋季活动', '2025-10-01', 4, '', '', '活动', ''],
    ['ACADEMIC-001', '同名样例', college, '', '春季活动', '2026-04-01', 3, '', '', '活动', ''],
    ['ACADEMIC-001', '同名样例', college, '', '暑期活动', '2026-08-01', 2, '', '', '活动', ''],
    ['ACADEMIC-001', '同名样例', college, '', '扣减重复项', '2026-04-01', -1, '', '', '调整', '扣减核实的重复项'],
    ['ACADEMIC-002', '同名样例', college, '', '同分活动', '2026-04-01', 8, '', '', '活动', ''],
    ['ACADEMIC-003', '第三样例', college, '', '其他活动', '2026-04-01', 5, '', '', '活动', ''],
  ]);
  const preview = await parsePreview(buffer);
  assert.strictEqual(preview.ok, 6); assert.strictEqual(preview.rows[0].grade, '25级');
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const imported = await confirmImport(preview.rows, adminId, 'test-incremental', 'fixture.xlsx', { file_hash: fileHash });
  assert.strictEqual(imported.count, 6);
  const before = await getDataVersion();
  const replay = await confirmImport(preview.rows.map((row) => ({ ...row, problem_confirmed: true })), adminId, 'another-note', 'fixture.xlsx', { file_hash: fileHash });
  assert.strictEqual(replay.count, 0); assert.strictEqual(replay.already_imported, true);
  assert.strictEqual((await db.query('SELECT COUNT(*)::int AS count FROM volunteer_logs')).rows[0].count, 6);
  const summary = await academic.getSummary({ academic_year: '2025-2026', college, grade: '25级', limit: 2 });
  assert.deepStrictEqual(summary.rows.map((row) => row.rank), [1, 1]);
  assert.strictEqual(summary.rows[0].total_hours, 8);
  const third = await academic.getSummary({ academic_year: '2025-2026', college, grade: '25级', page: 2, limit: 2 });
  assert.strictEqual(third.rows[0].rank, 2);
  const emptyPage = await academic.getSummary({ academic_year: '2025-2026', college, grade: '25级', page: 5, limit: 2 });
  assert.strictEqual(emptyPage.total_students, 3); assert.strictEqual(emptyPage.rows.length, 0);
  const person = await queryStudentLogs('ACADEMIC-001', '同名样例');
  assert.strictEqual(person.total_hours, 8); assert.strictEqual(person.academic_summaries[0].rank, 1);
  assert.strictEqual(person.academic_summaries[0].upper_hours, 4);
  assert.strictEqual(person.academic_summaries[0].lower_hours, 2);
  assert.strictEqual(person.academic_summaries[0].vacation_hours, 2);
  await assert.rejects(() => db.query("INSERT INTO volunteer_logs(student_id, student_name, activity_name, activity_date, hours, source, is_adjustment) VALUES ('BAD', '测试', '非法扣减', '2026-04-01', -1, 'online', true)"), /check constraint/);

  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  const jwt = require('jsonwebtoken');
  const { buildApp } = require('../src/app');
  const app = buildApp(); await app.ready();
  const token = (role, org_name = college) => jwt.sign({ id: adminId, username: 'academic-test-admin', role, org_name }, process.env.JWT_SECRET);
  const inject = (method, url, payload, role = 'admin', org_name = college) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token(role, org_name)}` } });
  try {
    const lookup = await inject('POST', '/api/v1/admin-search', { mode: 'student_name', value: '同名样例' });
    assert.strictEqual(lookup.statusCode, 200); assert.strictEqual(lookup.json().total_matches, 2);
    assert.strictEqual((await inject('POST', '/api/v1/admin-search', { mode: 'student_id', value: 'ACADEMIC-001', page: 'Infinity' })).statusCode, 400);
    assert.strictEqual((await inject('POST', '/api/v1/admin-search', { mode: 'student_id', value: 'ACADEMIC-001', other_value: 'x'.repeat(81) })).statusCode, 400);
    const combined = await inject('POST', '/api/v1/admin-search', { mode: 'student_name', value: '同名样例', other_value: 'ACADEMIC-002' });
    assert.strictEqual(combined.json().total_matches, 1);
    const publicTable = await app.inject({ method: 'POST', url: '/api/v1/query/summary', payload: { student_id: 'ACADEMIC-001', student_name: '同名样例', academic_year: '2025-2026', college: '任意其他学院', grade: '其他年级' } });
    assert.strictEqual(publicTable.statusCode, 200); assert.strictEqual(publicTable.json().rows.length, 3);
    assert(!publicTable.json().rows.find((row) => !row.is_self).student_id.includes('ACADEMIC'));
    assert.strictEqual(publicTable.json().college, college);
    const wrongPerson = await app.inject({ method: 'POST', url: '/api/v1/query/summary', payload: { student_id: 'ACADEMIC-001', student_name: '错误姓名', academic_year: '2025-2026' } });
    assert.strictEqual(wrongPerson.statusCode, 404);
    const id = person.records.find((record) => record.activity_name === '春季活动').id;
    const forbidden = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { hours: 0, note: '测试' }, 'college_admin', '车辆工程学院');
    assert.strictEqual(forbidden.statusCode, 403);
    const readOnly = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { hours: 0, note: '测试' }, 'auditor');
    assert.strictEqual(readOnly.statusCode, 403);
    const zeroNoReason = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { hours: 0 });
    assert.strictEqual(zeroNoReason.statusCode, 400);
    const invalidDate = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { activity_date: '2026-02-30', note: '测试' });
    assert.strictEqual(invalidDate.statusCode, 400);
    const update = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { hours: 0, note: '测试作废原活动时长' });
    assert.strictEqual(update.statusCode, 200);
    const refreshed = await queryStudentLogs('ACADEMIC-001', '同名样例');
    assert.strictEqual(refreshed.total_hours, 5); assert.notStrictEqual(refreshed.data_version.revision, before.revision);
    const negative = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { hours: -0.5, note: '核对后扣减半小时' });
    assert.strictEqual(negative.statusCode, 200);
    assert.strictEqual((await queryStudentLogs('ACADEMIC-001', '同名样例')).total_hours, 4.5);
    const renamed = await inject('PATCH', `/api/v1/reviews/logs/${id}`, { student_name: '更正样例', grade: '26级', note: '身份资料核对', sync_student_info: true });
    assert.strictEqual(renamed.statusCode, 200);
    assert.strictEqual(await queryStudentLogs('ACADEMIC-001', '同名样例'), null);
    assert.strictEqual((await queryStudentLogs('ACADEMIC-001', '更正样例')).records.length, 4);

    const activityResponse = await inject('POST', '/api/v1/activities', { name: '新学年边界活动', start_time: '2026-09-01T00:00:00+08:00', end_time: '2026-09-01T03:00:00+08:00' });
    assert.strictEqual(activityResponse.statusCode, 201);
    const activityId = activityResponse.json().id;
    const submitted = await inject('POST', '/api/v1/logs', { activity_id: activityId, records: [{ student_id: 'BOUNDARY-001', student_name: '边界样例', college, grade: '25级', hours: 1 }] });
    assert.strictEqual(submitted.statusCode, 201);
    const boundaryId = (await db.query("SELECT id FROM volunteer_logs WHERE student_id = 'BOUNDARY-001'")).rows[0].id;
    assert.strictEqual((await inject('PATCH', `/api/v1/logs/${boundaryId}/approve`)).statusCode, 200);
    const boundary = await queryStudentLogs('BOUNDARY-001', '边界样例');
    assert.strictEqual(boundary.records[0].activity_date, '2026-09-01');
    assert.strictEqual(boundary.academic_summaries[0].academic_year, '2026-2027');
    assert.strictEqual(boundary.academic_summaries[0].upper_hours, 1);
    const movedActivity = await inject('PUT', `/api/v1/activities/${activityId}`, { name: '寒假补录活动', start_time: '2026-09-01T00:00:00+08:00', end_time: '2026-09-01T03:00:00+08:00', academic_year: '2026-2027', academic_term: 'vacation' });
    assert.strictEqual(movedActivity.statusCode, 200);
    assert.strictEqual((await queryStudentLogs('BOUNDARY-001', '边界样例')).academic_summaries[0].vacation_hours, 1);
    console.log(JSON.stringify({ online_submission_shanghai_date: 'passed', edited_activity_reclassifies_logs: 'passed' }));
    const bad = await parsePreview(await workbook([['BAD-001', '样例', college, '25级', '扣减', '2026-04-01', '不是数字', '', '', '扣减', '说明']]));
    assert.strictEqual(bad.errors, 1);
    const snapshotBook = new ExcelJS.Workbook();
    snapshotBook.addWorksheet('25级').addRows([['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '累计服务时长'], ['SNAP-001', '累计样例', college, '25级', '学年累计', '2026-04-01', 10]]);
    const snapshot = await parsePreview(Buffer.from(await snapshotBook.xlsx.writeBuffer()));
    const rows = snapshot.rows.map((row) => ({ ...row, problem_confirmed: true }));
    await assert.rejects(() => confirmImport(rows, adminId, 'snapshot-key'), /累计表/);
    await confirmImport(rows, adminId, 'snapshot-key', 'snapshot.xlsx', { replace_existing_note: true });
    await confirmImport(rows.map((row) => ({ ...row, hours: 12 })), adminId, 'snapshot-key', 'snapshot-new.xlsx', { replace_existing_note: true });
    assert.strictEqual((await queryStudentLogs('SNAP-001', '累计样例')).total_hours, 12);
    const zeroPreview = await parsePreview(await workbook([['ZERO-001', '零累计样例', college, '25级', '零累计', '2026-04-01', 0, '', '', '活动', '']]));
    assert.strictEqual(zeroPreview.errors, 1, 'ordinary activity must remain positive');
    await confirmImport(rows.map((row) => ({ ...row, hours: 0 })), adminId, 'snapshot-key', 'snapshot-zero.xlsx', { replace_existing_note: true });
    assert.strictEqual((await queryStudentLogs('SNAP-001', '累计样例')).total_hours, 0, 'cumulative snapshot may clear previous hours to zero');

    const parallelRow = { student_id: 'PAR-001', student_name: '并发样例', college, grade: '25级', activity_name: '并发活动', activity_date: '2026-04-01', hours: 1, problem_confirmed: true };
    const parallel = await Promise.all([confirmImport([parallelRow], adminId, 'parallel-a'), confirmImport([parallelRow], adminId, 'parallel-b')]);
    assert.strictEqual(parallel.reduce((sum, result) => sum + result.count, 0), 1);
    assert.strictEqual((await queryStudentLogs('PAR-001', '并发样例')).total_hours, 1);
    console.log(JSON.stringify({ database: 'dedicated-postgresql', import_replay: 'passed', simultaneous_import: 'passed', grade_from_worksheet: 'passed', cumulative_replacement: 'passed', signed_hours: 'passed', tied_and_paged_ranking: 'passed', revision_refresh: 'passed', masked_public_summary: 'passed', combined_lookup: 'passed', identity_correction: 'passed', role_boundaries: 'passed' }));
  } finally { await app.close(); await require('../src/cache/redis').close(); await db.pool.end(); }
}
main().catch(async (error) => { console.error(error); await require('../src/cache/redis').close().catch(() => {}); await db.pool.end().catch(() => {}); process.exitCode = 1; });
