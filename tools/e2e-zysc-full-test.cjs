const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ExcelJS = require(path.resolve(__dirname, '../backend/node_modules/exceljs'));

const BASE_URL = process.env.E2E_BASE_URL || 'https://zysc.hanyao.me';
const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASS = process.env.E2E_ADMIN_PASS;
const MARK = process.env.E2E_MARK || `codex_e2e_${Date.now()}`;
const CHANNEL = process.env.E2E_BROWSER_CHANNEL || 'msedge';

if (!ADMIN_USER || !ADMIN_PASS) {
  throw new Error('Missing E2E_ADMIN_USER or E2E_ADMIN_PASS');
}

const artifactDir = path.resolve(
  process.cwd(),
  'import-output',
  `e2e-zysc-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
fs.mkdirSync(artifactDir, { recursive: true });

const bannedPublicText = /(源表|未拆分|拆分时长|拆分明细|已拆分)/;
const results = [];
const consoleIssues = [];
let page;
let apiToken = '';
let testActivityName = `${MARK} 活动创建`;
let testActivityUpdatedName = `${MARK} 活动更新`;
let testActivityId = '';
const onlineStudent = {
  id: `${MARK.replace(/\D/g, '').slice(-8).padStart(8, '9')}01`,
  name: `${MARK}_填报学生`,
};
const importStudent = {
  id: `${MARK.replace(/\D/g, '').slice(-8).padStart(8, '9')}02`,
  name: `${MARK}_导入学生`,
};
const problemStudent = {
  id: `${MARK.replace(/\D/g, '').slice(-8).padStart(8, '9')}03`,
  name: `${MARK}_问题学生`,
};

function assertNoLegacyText(text, context) {
  assert.equal(bannedPublicText.test(text), false, `${context} contains legacy placeholder wording`);
}

async function screenshot(name) {
  if (!page) return null;
  const file = path.join(artifactDir, `${String(results.length + 1).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function step(name, fn) {
  const startedAt = Date.now();
  try {
    const data = await fn();
    results.push({ name, status: 'passed', duration_ms: Date.now() - startedAt, data: data || null });
  } catch (error) {
    let shot = null;
    try {
      shot = await screenshot(`failed-${name.replace(/[^\w.-]+/g, '_')}`);
    } catch {
      // keep original failure
    }
    results.push({
      name,
      status: 'failed',
      duration_ms: Date.now() - startedAt,
      error: error.stack || error.message,
      screenshot: shot,
    });
  }
}

async function expectText(text, timeout = 10000) {
  await page.waitForFunction(
    (value) => document.body && document.body.innerText.includes(value),
    text,
    { timeout }
  );
}

async function clickNav(label) {
  const nav = page.locator('nav[aria-label="管理后台导航"]');
  const button = nav.locator('button').filter({ hasText: label });
  await assertCount(button, 1, `nav ${label}`);
  await button.click();
}

async function assertCount(locator, expected, label) {
  const count = await locator.count();
  assert.equal(count, expected, `${label} expected ${expected}, got ${count}`);
}

async function waitForCheck(label, fn, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError || new Error(`${label} timed out`);
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  }
  const response = await fetch(`${BASE_URL}${pathname}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text();
  return { response, body };
}

async function buildImportFixture(filename, rows) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');
  worksheet.addRows([
    ['说明行'],
    ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'],
    ...rows,
  ]);
  const file = path.join(artifactDir, filename);
  await workbook.xlsx.writeFile(file);
  return file;
}

async function apiUploadPreview(file) {
  const form = new FormData();
  const buffer = fs.readFileSync(file);
  form.append('file', new Blob([buffer]), path.basename(file));
  const response = await fetch(`${BASE_URL}/api/v1/import/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}` },
    body: form,
  });
  return {
    response,
    body: await response.json().catch(() => null),
  };
}

function previewRowKey(row) {
  return `${row?.sheet || ''}:${row?.row || ''}:${row?.student_id || ''}:${row?.student_name || ''}`;
}

function isExpectedConsoleIssue(issue) {
  const text = issue?.text || '';
  const url = issue?.url || '';
  return (
    (url.includes('/query/') && text.includes('status of 404')) ||
    (url.includes('/admin/') && text.includes('status of 401'))
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true, channel: CHANNEL });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    acceptDownloads: true,
    locale: 'zh-CN',
  });
  page = await context.newPage();
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleIssues.push({ type: msg.type(), text: msg.text(), url: page.url() });
    }
  });
  page.on('pageerror', (err) => {
    consoleIssues.push({ type: 'pageerror', text: err.message, url: page.url() });
  });

  await step('公开接口健康检查', async () => {
    const health = await api('/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, 'ok');
    const meta = await api('/api/v1/query/meta');
    assert.equal(meta.response.status, 200);
    assertNoLegacyText(JSON.stringify(meta.body), 'query meta');
    return { health: health.body.status, data_version: meta.body.source_name };
  });

  await step('查询页有效查询和明细控件', async () => {
    await page.goto(`${BASE_URL}/query/`, { waitUntil: 'networkidle' });
    await expectText('志愿时长查询');
    await screenshot('query-home');

    await page.getByRole('button', { name: '查询' }).click();
    await expectText('请输入学号和姓名后再查询。');

    await page.getByLabel('学号').fill('TEST-STUDENT-001');
    await page.getByLabel('姓名').fill('测试用户A');
    await page.getByRole('button', { name: '查询' }).click();
    await page.locator('.result-panel').waitFor({ state: 'visible', timeout: 15000 });
    await expectText('累计总时长');
    await expectText('活动明细');
    await expectText('HD-001');

    const text = await page.locator('body').innerText();
    assertNoLegacyText(text, 'public query result');
    const rows = await page.locator('tbody tr').count();
    assert(rows > 0, 'query should render activity rows');

    await page.getByPlaceholder('活动名称、来源、周期').fill('人大选举');
    await expectText('人大选举志愿者');
    const filtered = await page.locator('tbody tr').count();
    assert(filtered >= 1 && filtered <= rows, 'keyword filter should reduce or keep matching rows');

    await page.getByPlaceholder('活动名称、来源、周期').fill('');
    await page.locator('.records-controls label').filter({ hasText: '分组' }).locator('select').selectOption('source');
    await expectText('导入记录');
    await page.locator('.records-controls label').filter({ hasText: '排序' }).locator('select').selectOption('hours_desc');
    await screenshot('query-result-filtered');
    return { rendered_rows: rows, filtered_rows: filtered };
  });

  await step('查询页未命中提示', async () => {
    await page.getByLabel('学号').fill(`${MARK}NORESULT`);
    await page.getByLabel('姓名').fill('不存在');
    await page.getByRole('button', { name: '查询' }).click();
    await expectText('未查到匹配记录');
  });

  await step('后台登录失败与成功', async () => {
    await page.goto(`${BASE_URL}/admin/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await expectText('管理后台登录');

    await page.getByLabel('账号').fill(`${ADMIN_USER}_bad`);
    await page.getByLabel('密码').fill('bad-password');
    await page.getByRole('button', { name: /登录/ }).click();
    await expectText('用户名或密码错误');

    await page.getByLabel('账号').fill(ADMIN_USER);
    await page.getByLabel('密码').fill(ADMIN_PASS);
    await page.getByRole('button', { name: /登录/ }).click();
    await page.locator('.admin-shell').waitFor({ state: 'visible', timeout: 15000 });
    await expectText('API 已连接');
    await screenshot('admin-overview');

    const token = await page.evaluate(() => localStorage.getItem('adminToken'));
    assert(token && token.length > 20, 'admin token should be stored after login');
    apiToken = token;
    return { logged_in: true };
  });

  await step('后台概览和导航模块可达', async () => {
    for (const item of ['概览', '活动', '填报', '审核', '问题复核', '导入', '统计', '运维状态', '用户', '日志']) {
      await clickNav(item);
      await expectText(item === '日志' ? '操作日志' : item);
    }
    await screenshot('admin-navigation');
  });

  await step('活动创建、编辑、归档和恢复', async () => {
    await clickNav('活动');
    await expectText('活动管理');
    await page.getByLabel('活动名称').fill(testActivityName);
    await page.getByLabel('开始时间').fill('2026-04-28T10:00');
    await page.getByLabel('结束时间').fill('2026-04-28T12:00');
    await page.getByLabel('地点').fill(`${MARK} 地点`);
    await page.getByLabel('负责单位').fill('计算机科学与工程学院');
    await page.getByLabel('描述').fill(`${MARK} 自动化创建`);
    await page.getByRole('button', { name: /保存/ }).click();
    await expectText('活动已创建');
    await expectText(testActivityName);

    let row = page.locator('tr').filter({ hasText: testActivityName });
    await assertCount(row, 1, 'created activity row');
    await row.getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('活动名称').fill(testActivityUpdatedName);
    await page.getByRole('button', { name: /保存/ }).click();
    await expectText('活动已更新');
    await expectText(testActivityUpdatedName);

    row = page.locator('tr').filter({ hasText: testActivityUpdatedName });
    await row.getByRole('button', { name: '归档' }).click();
    await expectText('已归档');
    await row.getByRole('button', { name: '恢复' }).click();
    await expectText('进行中');

    const list = await api('/api/v1/activities');
    assert.equal(list.response.status, 200);
    const activity = list.body.find((item) => item.name === testActivityUpdatedName);
    assert(activity?.id, 'created activity should be returned by API');
    testActivityId = activity.id;
    return { activity_id: testActivityId };
  });

  await step('填报和审核在线记录', async () => {
    await clickNav('填报');
    await expectText('时长填报');
    await page.getByLabel('关联活动').selectOption({ label: testActivityUpdatedName });
    await page.getByLabel('粘贴表格').fill([
      onlineStudent.id,
      onlineStudent.name,
      '计算机科学与工程学院',
      '25级',
      '2.5',
      '',
    ].join('\t'));
    await page.getByRole('button', { name: '解析预览' }).click();
    await expectText(onlineStudent.name);
    await page.getByRole('button', { name: /提交填报/ }).click();
    await expectText('已提交 1 条记录，等待审核');

    await clickNav('审核');
    await expectText('审核管理');
    await page.getByRole('button', { name: '查询' }).click();
    const row = page.locator('tr').filter({ hasText: onlineStudent.id });
    await row.waitFor({ state: 'visible', timeout: 10000 });
    await row.getByRole('button', { name: '通过' }).click();
    await expectText('已通过');
    await waitForCheck('approved online log', async () => {
      const response = await api(`/api/v1/logs?student_id=${encodeURIComponent(onlineStudent.id)}&status=approved&limit=5`);
      assert.equal(response.response.status, 200);
      return Array.isArray(response.body) && response.body.some((item) => item.student_id === onlineStudent.id);
    }, 15000);
    return { student_id: onlineStudent.id };
  });

  await step('新审核记录可在查询端查到', async () => {
    await waitForCheck('public query sees approved online log', async () => {
      const response = await api('/api/v1/query', {
        method: 'POST',
        json: { student_id: onlineStudent.id, student_name: onlineStudent.name },
      });
      return response.response.status === 200 && Number(response.body?.total_hours || 0) > 0;
    }, 15000);
    await page.goto(`${BASE_URL}/query/`, { waitUntil: 'networkidle' });
    await page.getByLabel('学号').fill(onlineStudent.id);
    await page.getByLabel('姓名').fill(onlineStudent.name);
    await page.getByRole('button', { name: '查询' }).click();
    await page.locator('.result-panel').waitFor({ state: 'visible', timeout: 15000 });
    await expectText(testActivityUpdatedName);
    await expectText('在线记录');
    const text = await page.locator('body').innerText();
    assertNoLegacyText(text, 'online query result');
  });

  await step('问题复核确认流程', async () => {
    await page.goto(`${BASE_URL}/admin/`, { waitUntil: 'networkidle' });
    await clickNav('问题复核');
    await expectText('问题复核');
    await page.getByLabel('搜索问题数据').fill(MARK);
    await page.getByRole('button', { name: '查询' }).click();
    await expectText(problemStudent.name);
    const row = page.locator('tr').filter({ hasText: problemStudent.id });
    await row.waitFor({ state: 'visible', timeout: 10000 });
    page.once('dialog', async (dialog) => {
      assert.equal(dialog.type(), 'prompt');
      await dialog.accept(`${MARK} 复核确认`);
    });
    await row.getByRole('button', { name: '确认' }).click();
    await expectText('已保存复核确认');
  });

  await step('Excel 导入页面预览和问题确认控件', async () => {
    const file = await buildImportFixture(`${MARK}-ui-preview.xlsx`, [
      [`${MARK}UI01`, `${MARK}_正常`, '计算机科学与工程学院', '25级', `${MARK} 导入正常`, '2026-04-28', 1.5, ''],
      [`${MARK}UI02`, `${MARK}_超大`, '车辆工程学院', '25级', `${MARK} 导入超大`, '2026-04-28', 201, ''],
      [`${MARK}UI03`, `${MARK}_错误`, '不存在学院', '25级', `${MARK} 导入错误`, '2026-04-28', 1, ''],
    ]);
    await clickNav('导入');
    await expectText('Excel 导入');
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.getByLabel('批次备注').fill(`${MARK} UI 预览`);
    await page.getByRole('button', { name: /解析预览/ }).click();
    await expectText('预览：共 3');
    await expectText('正常记录');
    await expectText('不可导入错误');
    await page.getByRole('button', { name: '确认全部问题行' }).click();
    await expectText('导入 2 条');
    await screenshot('admin-import-preview');
  });

  await step('导入 API 预览、未确认拦截和确认导入', async () => {
    const file = await buildImportFixture(`${MARK}-api-import.xlsx`, [
      [importStudent.id, importStudent.name, '计算机科学与工程学院', '25级', `${MARK} API 导入正常`, '2026-04-28', 1.5, ''],
      [`${importStudent.id}B`, `${importStudent.name}B`, '计算机科学与工程学院', '25级', `${MARK} API 导入超大`, '2026-04-28', 201, ''],
    ]);
    const preview = await apiUploadPreview(file);
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.total, 2);
    assert.equal(preview.body.warnings, 1);
    assert(preview.body.diff_report.importable_rows >= 2);

    const blocked = await api('/api/v1/import/confirm', {
      method: 'POST',
      json: { preview_id: preview.body.preview_id, confirmed_row_keys: [], note: `${MARK} API 导入` },
    });
    assert.equal(blocked.response.status, 400);
    assert.match(blocked.body.message, /未确认/);

    const warningKeys = preview.body.rows.filter((row) => row.status === 'warning').map(previewRowKey);
    const confirmed = await api('/api/v1/import/confirm', {
      method: 'POST',
      json: {
        preview_id: preview.body.preview_id,
        confirmed_row_keys: warningKeys,
        note: `${MARK} API 导入`,
      },
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.success, true);
    assert.equal(confirmed.body.count, 2);
    return { imported: confirmed.body.count, confirmed_problem_count: confirmed.body.confirmed_problem_count };
  });

  await step('统计、导出、运维、用户、日志页面', async () => {
    await clickNav('统计');
    await expectText('统计');
    await expectText('总时长');
    const [statsDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /导出 Excel/ }).click(),
    ]);
    const statsFile = path.join(artifactDir, await statsDownload.suggestedFilename());
    await statsDownload.saveAs(statsFile);
    assert(fs.statSync(statsFile).size > 0, 'stats export should have content');

    await clickNav('导入');
    const [templateDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '下载模板' }).click(),
    ]);
    const templateFile = path.join(artifactDir, await templateDownload.suggestedFilename());
    await templateDownload.saveAs(templateFile);
    assert(fs.statSync(templateFile).size > 0, 'template download should have content');

    await clickNav('运维状态');
    await expectText('运维状态');
    await expectText('数据库');
    await expectText('备份');

    await clickNav('用户');
    await expectText('用户管理');
    const newUser = `${MARK}_organizer`;
    await page.getByLabel('用户名').fill(newUser);
    await page.getByLabel('初始密码').fill(`Pass_${MARK}_123!`);
    await page.getByLabel('真实姓名').fill(`${MARK} 组织者`);
    await page.getByLabel('角色').selectOption('organizer');
    await page.getByLabel('所属组织').fill('计算机科学与工程学院');
    await page.getByRole('button', { name: /创建用户/ }).click();
    await expectText('用户已创建');
    await expectText(newUser);
    let userRow = page.locator('tr').filter({ hasText: newUser });
    await userRow.getByRole('button', { name: '禁用' }).click();
    await expectText('禁用');
    userRow = page.locator('tr').filter({ hasText: newUser });
    await userRow.getByRole('button', { name: '启用' }).click();
    await expectText('启用');
    userRow = page.locator('tr').filter({ hasText: newUser });
    page.once('dialog', async (dialog) => {
      assert.equal(dialog.type(), 'prompt');
      await dialog.accept(`Reset_${MARK}_123!`);
    });
    await userRow.getByRole('button', { name: '重置密码' }).click();
    await expectText('密码已重置');

    await clickNav('日志');
    await expectText('操作日志');
    await expectText('users.create');
    await screenshot('admin-ops-users-audit');
  });

  await step('鉴权和核心 API 覆盖', async () => {
    const unauthorized = await fetch(`${BASE_URL}/api/v1/users`);
    assert([401, 403].includes(unauthorized.status), `users without token should be blocked, got ${unauthorized.status}`);

    for (const endpoint of [
      '/api/v1/auth/me',
      '/api/v1/stats/overview',
      '/api/v1/stats/by-college',
      '/api/v1/stats/by-month',
      '/api/v1/stats/rankings',
      '/api/v1/stats/problems',
      '/api/v1/ops/status',
      '/api/v1/users',
      '/api/v1/users/roles',
      '/api/v1/users/operation-logs',
      '/api/v1/import/batches',
      '/api/v1/activities',
      '/api/v1/logs?limit=5',
      '/api/v1/reviews/problem-logs?limit=5',
    ]) {
      const response = await api(endpoint);
      assert.equal(response.response.status, 200, `${endpoint} should return 200`);
    }

    const importedQuery = await api('/api/v1/query', {
      method: 'POST',
      json: { student_id: importStudent.id, student_name: importStudent.name },
    });
    assert.equal(importedQuery.response.status, 200);
    assertNoLegacyText(JSON.stringify(importedQuery.body), 'imported query result');
    return { checked_endpoints: 14 };
  });

  await browser.close();

  const failed = results.filter((item) => item.status === 'failed');
  const unexpectedConsoleIssues = consoleIssues.filter((issue) => !isExpectedConsoleIssue(issue));
  const report = {
    ok: failed.length === 0,
    base_url: BASE_URL,
    marker: MARK,
    artifact_dir: artifactDir,
    browser_channel: CHANNEL,
    counts: {
      passed: results.length - failed.length,
      failed: failed.length,
      console_issues: consoleIssues.length,
      unexpected_console_issues: unexpectedConsoleIssues.length,
    },
    console_issues: consoleIssues.slice(0, 20),
    unexpected_console_issues: unexpectedConsoleIssues.slice(0, 20),
    results,
  };
  const reportFile = path.join(artifactDir, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: report.ok,
    report_file: reportFile,
    artifact_dir: artifactDir,
    passed: report.counts.passed,
    failed: report.counts.failed,
    console_issues: report.counts.console_issues,
    unexpected_console_issues: report.counts.unexpected_console_issues,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  const reportFile = path.join(artifactDir, 'fatal.json');
  fs.writeFileSync(reportFile, JSON.stringify({
    ok: false,
    error: error.stack || error.message,
    results,
  }, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
});

