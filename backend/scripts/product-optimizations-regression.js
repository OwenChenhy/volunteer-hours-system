const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const db = require('../src/db');
const { hasCapability, hasFullAccess } = require('../src/middlewares/rbac');

db.query = async (sql) => {
  if (/SELECT 1 AS ok/i.test(sql)) return { rows: [{ ok: 1 }] };
  if (/COUNT\(\*\)::int FROM volunteer_logs/i.test(sql)) {
    return { rows: [{ volunteer_logs: 0, import_batches: 0, users: 1 }] };
  }
  return { rows: [] };
};

const { parsePreview } = require('../src/services/importService');
const { queryDraftStudentLogs: queryStudentLogs } = require('../src/services/queryService');
const { buildApp } = require('../src/app');
const { extractActivities, extractActivityDetails } = require('../../tools/prepare-march-public-detail-import');

async function buildProductFixture() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Sheet1').addRows([
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'],
    ['TEST-STUDENT-P001', '正式学院', '计算机科学与工程学院', '25级', '活动A', '2026-04-25', 2.5, ''],
    ['TEST-STUDENT-P002', '异常学院', '不存在学院', '25级', '活动B', '2026-04-25', 1, ''],
    ['TEST-STUDENT-P003', '大时长', '车辆工程学院', '25级', '活动C', '2026-04-25', 201, ''],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function main() {
  assert(hasFullAccess({ role: 'super_admin' }), 'super_admin should have full access');
  assert(hasCapability('data_admin', 'import:manage'), 'data_admin should manage imports');
  assert(!hasCapability('college_admin', 'reviews:manage'), 'college_admin submits records; office reviewers manage approval');
  assert(hasCapability('college_admin', 'activities:write') && hasCapability('college_admin', 'logs:submit'), 'college_admin should submit its activities and participants');
  assert(!hasCapability('auditor', 'reviews:manage'), 'auditor must stay read-only');

  const malformedActivities = extractActivities('世预赛活动志愿者（16小时）暑期三下乡活动（56小时、校区迎新志愿服务活动（16小时）、渝超足球联赛志愿活动 （8小时）');
  assert.deepStrictEqual(
    malformedActivities.map((row) => `${row.activity_name}:${row.hours}`),
    [
      '世预赛活动志愿者:16',
      '暑期三下乡活动:56',
      '校区迎新志愿服务活动:16',
      '渝超足球联赛志愿活动:8',
    ],
    'malformed source activity text should recover missing right parenthesis before next activity',
  );
  assert(
    !malformedActivities.some((row) => row.activity_name.includes('56小时')),
    'hour text must not leak into the next activity name',
  );
  const unresolvedDetails = extractActivityDetails('4.19五一健康跑（7小时）、重庆市第二届“尼小程杯”计算机科普大赛');
  assert.deepStrictEqual(
    unresolvedDetails.unresolved.map((row) => row.activity_name),
    ['重庆市第二届“尼小程杯”计算机科普大赛'],
    'single no-hour activity text should be available for naming supplement records',
  );

  const preview = await parsePreview(await buildProductFixture());
  assert.strictEqual(preview.total, 3);
  assert.strictEqual(preview.ok, 1);
  assert.strictEqual(preview.warnings, 1);
  assert.strictEqual(preview.errors, 1);
  assert.strictEqual(preview.diff_report.importable_rows, 2);
  assert.strictEqual(preview.diff_report.unknown_college_rows, 1);
  assert.strictEqual(preview.diff_report.large_hour_rows, 1);

  const defaultQuery = db.query;
  db.query = async (sql, params) => {
    if (/FROM volunteer_logs/i.test(sql) && /student_id = \$1/i.test(sql)) {
      assert.deepStrictEqual(params, ['TEST-STUDENT-P004', '累计项']);
      return {
        rows: [{
          student_id: 'TEST-STUDENT-P004',
          student_name: '累计项',
          college: '计算机科学与工程学院',
          grade: '25级',
          activity_name: '源表累计未拆分时长',
          activity_date: '2026-04-25',
          activity_period: '源表累计',
          hours: '2',
          source: 'imported',
          import_detail_status: 'summary_no_detail',
          source_total_hours: '2',
          created_at: '2026-04-25T00:00:00Z',
        }],
      };
    }
    if (/FROM import_batches/i.test(sql)) {
      return {
        rows: [{
          batch_id: '00000000-0000-0000-0000-000000000001',
          filename: 'fixture.xlsx',
          note: 'fixture',
          record_count: 1,
          created_at: '2026-04-25T00:00:00Z',
        }],
      };
    }
    return defaultQuery(sql, params);
  };
  const publicQuery = await queryStudentLogs('TEST-STUDENT-P004', '累计项');
  db.query = defaultQuery;
  assert.strictEqual(publicQuery.records[0].activity_name, '累计时长记录');
  assert.strictEqual(publicQuery.records[0].activity_time_label, '累计记录');
  assert.strictEqual(publicQuery.records[0].is_summary_record, true);
  assert(!JSON.stringify(publicQuery).includes('源表'), 'public query payload must not expose legacy placeholder wording');

  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volunteer-source-'));
  const sourceFile = 'source-row-fixture.xlsx';
  const sourceWorkbook = new ExcelJS.Workbook();
  sourceWorkbook.addWorksheet('25级').addRows([
    ['学号', '姓名', '学院', '年级', '2025-2026上半年活动名称', '服务时长（小时）', '联系方式'],
    ['TEST-STUDENT-P005', '原始行', '计算机科学与工程学院', '25级', '活动甲(2小时)、活动乙(3小时)', 6, 'TEST-PHONE'],
  ]);
  await sourceWorkbook.xlsx.writeFile(path.join(sourceDir, sourceFile));
  process.env.IMPORT_SOURCE_DIR = sourceDir;

  process.env.JWT_SECRET = process.env.JWT_SECRET || 'product-regression-secret';
  const app = buildApp();
  try {
    await app.ready();
    const token = jwt.sign({
      id: '00000000-0000-0000-0000-000000000000',
      username: 'admin',
      real_name: '管理员',
      role: 'admin',
    }, process.env.JWT_SECRET);

    const roles = await app.inject({
      method: 'GET',
      url: '/api/v1/users/roles',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(roles.statusCode, 200);
    assert(roles.json().some((role) => role.value === 'data_admin'), 'roles endpoint should expose data_admin');

    const routeQuery = db.query;
    let allProblemSql = '';
    let unprocessedProblemSql = '';
    db.query = async (sql, params) => {
      if (/SELECT \* FROM volunteer_logs WHERE id = \$1/i.test(sql) && params?.[0] === 'source-log-id') {
        return {
          rows: [{
            id: 'source-log-id',
            student_id: 'TEST-STUDENT-P005',
            student_name: '原始行',
            college: '计算机科学与工程学院',
            grade: '25级',
            phone: 'TEST-PHONE',
            activity_name: '累计时长记录',
            activity_period: '累计记录',
            activity_date: '2026-03-31',
            hours: '1.0',
            source: 'imported',
            import_detail_status: 'supplement',
            source_total_hours: '6.0',
            source_file: sourceFile,
            source_sheet: '25级',
            source_row: 2,
            is_legacy_processed: false,
          }],
        };
      }
      if (/FROM volunteer_logs l/i.test(sql) && /review_notes/i.test(sql)) {
        if (Array.isArray(params?.[0]) && params[0].includes('reviewed')) allProblemSql = sql;
        if (Array.isArray(params?.[0]) && !params[0].includes('reviewed')) unprocessedProblemSql = sql;
      }
      return routeQuery(sql, params);
    };

    const reviews = await app.inject({
      method: 'GET',
      url: '/api/v1/reviews/problem-logs?limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(reviews.statusCode, 200);
    assert(/l\.import_detail_status = ANY/i.test(allProblemSql), 'all problem logs should filter by problem status');
    assert(!/OR l\.is_legacy_processed = false/i.test(allProblemSql), 'all problem logs must not include parsed unprocessed rows');

    const unprocessedReviews = await app.inject({
      method: 'GET',
      url: '/api/v1/reviews/problem-logs?type=unprocessed&limit=1',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(unprocessedReviews.statusCode, 200);
    assert(/l\.import_detail_status = ANY/i.test(unprocessedProblemSql), 'unprocessed problem logs should still filter by problem status');
    assert(/l\.is_legacy_processed = false/i.test(unprocessedProblemSql), 'unprocessed problem logs should filter pending review state');

    const sourceRow = await app.inject({
      method: 'GET',
      url: '/api/v1/reviews/logs/source-log-id/source-row',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(sourceRow.statusCode, 200);
    assert(sourceRow.json().cells.some((cell) => cell.header === '2025-2026上半年活动名称' && cell.value.includes('活动甲')), 'source row should expose raw Excel activity text');
    db.query = routeQuery;

    const ops = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/status',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(ops.statusCode, 200);
    assert.strictEqual(ops.json().supabase.configured, false);
  } finally {
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    roles_checked: ['super_admin', 'data_admin', 'college_admin', 'auditor'],
    preview_diff_report: preview.diff_report,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

