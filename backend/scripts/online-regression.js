const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const baseUrl = process.env.BASE_URL || 'https://zysc.hanyao.me';
const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD;

function requireEnv(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function buildFixture() {
  const workbook = new ExcelJS.Workbook();
  const date = new Date(2026, 3, 25);
  workbook.addWorksheet('有标题').addRows([
    ['标题行，不是表头'],
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'],
    ['TEST-STUDENT-ONLINE', '线上回归', '计算机科学与工程学院', '25级', '活动A', date, 2.55, 'TEST-PHONE'],
    ['TEST-STUDENT-ONLINE', '线上回归', '计算机科学与工程学院', '25级', '活动A', date, 2.5, 'TEST-PHONE'],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  requireEnv(password, 'ADMIN_PASSWORD');

  const login = await requestJson('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!login.response.ok) throw new Error(`login failed: ${login.response.status}`);

  const auth = { Authorization: `Bearer ${login.body.access_token}` };

  const forged = await requestJson('/api/v1/import/confirm', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: [{ student_id: 'BAD', student_name: '伪造', activity_name: '伪造', activity_date: '2026-04-25', hours: 1 }]
    }),
  });
  if (forged.response.status !== 400) throw new Error(`forged confirm should be rejected, got ${forged.response.status}`);

  const form = new FormData();
  form.append('file', new Blob([await buildFixture()]), 'online-import-regression.xlsx');
  const previewResponse = await fetch(`${baseUrl}/api/v1/import/preview`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  const preview = await previewResponse.json();
  if (!previewResponse.ok) throw new Error(`preview failed: ${previewResponse.status}`);
  if (preview.total !== 2) throw new Error(`expected 2 preview rows, got ${preview.total}`);
  if (preview.diff_report?.importable_rows !== 2) throw new Error('preview diff report missing importable rows');
  if (preview.rows[0].activity_date !== '2026-04-25') throw new Error('date shifted in online preview');
  if (!preview.rows[1].issues.some((issue) => issue.code === 'duplicate_in_file')) {
    throw new Error('duplicate_in_file missing in online preview');
  }

  const unconfirmed = await requestJson('/api/v1/import/confirm', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ preview_id: preview.preview_id, confirmed_row_keys: [] }),
  });
  if (unconfirmed.response.status !== 400) {
    throw new Error(`unconfirmed warning should be rejected, got ${unconfirmed.response.status}`);
  }

  const query = await requestJson('/api/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      student_id: process.env.SAMPLE_STUDENT_ID || 'TEST-STUDENT-001',
      student_name: process.env.SAMPLE_STUDENT_NAME || '测试用户A',
    }),
  });
  if (!query.response.ok || Number(query.body.total_hours || 0) <= 0) {
    throw new Error(`public query failed: ${query.response.status}`);
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    forged_status: forged.response.status,
    preview_rows: preview.total,
    unconfirmed_status: unconfirmed.response.status,
    sample_total_hours: query.body.total_hours
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

