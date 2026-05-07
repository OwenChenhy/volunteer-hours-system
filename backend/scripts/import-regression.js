const assert = require('assert');
const ExcelJS = require('exceljs');
const db = require('../src/db');

db.query = async () => ({ rows: [] });

let insertedLogs = 0;
db.pool.connect = async () => ({
  query: async (sql) => {
    if (/INSERT INTO import_batches/i.test(sql)) {
      return { rows: [{ id: 'mock-batch-id' }], rowCount: 1 };
    }
    if (/INSERT INTO volunteer_logs/i.test(sql)) {
      insertedLogs += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  release() {}
});

const { parsePreview, confirmImport } = require('../src/services/importService');

async function buildWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const date = new Date(2026, 3, 25);

  workbook.addWorksheet('有标题').addRows([
    ['标题行，不是表头'],
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'],
    ['TEST-STUDENT-R001', '日期学生', '计算机科学与工程学院', '25级', '活动A', date, 2.55, 'TEST-PHONE'],
    ['TEST-STUDENT-R001', '日期学生', '计算机科学与工程学院', '25级', '活动A', date, 2.5, 'TEST-PHONE'],
  ]);

  workbook.addWorksheet('第二表').addRows([
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'],
    ['TEST-STUDENT-R002', '第二表', '计算机科学与工程学院', '25级', '活动B', '2026-04-26', 1, ''],
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildInvalidWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Sheet1').addRows([
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'],
    ['TEST-STUDENT-R003', '超限学生', '计算机科学与工程学院', '25级', '活动C', '2026-04-27', 10000, ''],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function main() {
  const preview = await parsePreview(await buildWorkbookBuffer());

  assert.strictEqual(preview.total, 3, 'all sheets should be parsed');
  assert.strictEqual(preview.ok, 2, 'two rows should be normal');
  assert.strictEqual(preview.warnings, 1, 'one row should require confirmation');
  assert.strictEqual(preview.errors, 0, 'valid sample should have no hard errors');
  assert.strictEqual(preview.diff_report.total_rows, 3, 'diff report should summarize total rows');
  assert.strictEqual(preview.diff_report.importable_rows, 3, 'diff report should summarize importable rows');
  assert.strictEqual(preview.diff_report.importable_hours, 6.1, 'diff report should summarize importable hours');
  assert.strictEqual(preview.diff_report.by_college[0].college, '计算机科学与工程学院');
  assert.strictEqual(preview.rows[0].sheet, '有标题');
  assert.strictEqual(preview.rows[0].row, 3, 'header offset should preserve Excel row number');
  assert.strictEqual(preview.rows[0].activity_date, '2026-04-25', 'Excel Date must not shift by timezone');
  assert.strictEqual(preview.rows[0].hours, 2.6, 'hours should match NUMERIC(6,1) precision');
  assert(preview.rows[1].issues.some((issue) => issue.code === 'duplicate_in_file'), 'duplicate in same import file should warn');

  await assert.rejects(
    () => confirmImport(preview.rows, '00000000-0000-0000-0000-000000000000', 'regression', 'regression.xlsx'),
    /需管理员勾选确认/,
    'warning rows must be confirmed before import'
  );

  insertedLogs = 0;
  const confirmedRows = preview.rows.map((row) => ({
    ...row,
    problem_confirmed: row.status === 'warning'
  }));
  const result = await confirmImport(
    confirmedRows,
    '00000000-0000-0000-0000-000000000000',
    'regression',
    'regression.xlsx'
  );
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.confirmed_problem_count, 1);
  assert.strictEqual(result.replaced_batch_count, 0);
  assert.strictEqual(result.replaced_record_count, 0);
  assert.strictEqual(insertedLogs, 3);

  const invalidPreview = await parsePreview(await buildInvalidWorkbookBuffer());
  assert.strictEqual(invalidPreview.errors, 1, 'hours over DB limit should be a hard error');
  assert(invalidPreview.rows[0].issues.some((issue) => issue.code === 'hours_too_large'));

  console.log(JSON.stringify({
    ok: true,
    parsed_rows: preview.total,
    warning_codes: preview.rows[1].issues.map((issue) => issue.code),
    confirmed_count: result.count,
    invalid_errors: invalidPreview.errors
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

