const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const url = new URL(process.env.EXPORT_TEST_DATABASE_URL || 'invalid:');
assert.equal(url.pathname, '/volunteer_export_test_20261019', 'requires the isolated export database');
assert(['127.0.0.1', 'localhost', 'db', 'postgres'].includes(url.hostname));
process.env.DATABASE_URL = url.href;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const { buildApp } = require('../src/app');
const { createArchive } = require('../src/services/publicationExportService');
const manifest = require('../templates/publication/manifest.json');
const app = buildApp();
app.log.level = 'silent';
const checks = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
const key = row => JSON.stringify([row.student_id, row.student_name]);

async function readArchive(buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const result = [];
  for (const file of Object.values(zip.files).filter(file => file.name.endsWith('.xlsx'))) {
    const workbook = new ExcelJS.Workbook();
    const raw = await file.async('nodebuffer');
    await workbook.xlsx.load(raw);
    result.push({ name: file.name, workbook, raw });
  }
  return result;
}

function studentsIn(books) {
  const found = new Map();
  for (const { workbook } of books) for (const sheet of workbook.worksheets) {
    sheet.eachRow((row, number) => {
      if (number <= 1 || !row.getCell(5).value) return;
      const person = { student_id: row.getCell(5).value, student_name: row.getCell(1).value,
        college: row.getCell(3).value, grade: row.getCell(4).value || '', hours: row.getCell(7).value, row, sheet };
      assert.equal(typeof person.student_id, 'string', 'student IDs must remain text');
      assert.equal(typeof person.hours, 'number', 'hours must be numeric');
      assert(!found.has(key(person)), 'a published student must be exported exactly once');
      assert.equal(row.getCell(2).value || '', '', 'missing gender is not invented');
      assert.equal(row.getCell(6).value || '', '', 'unpublished phone cannot leak');
      found.set(key(person), person);
    });
  }
  return found;
}

async function integrity() {
  return (await db.query(`SELECT
    (SELECT md5(jsonb_agg(to_jsonb(l) ORDER BY id)::text) FROM volunteer_logs l) AS logs,
    (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM publication_batches p) AS publications,
    (SELECT md5(jsonb_agg(to_jsonb(s))::text) FROM publication_state s) AS state,
    (SELECT revision::text FROM data_versions WHERE id=true) AS revision`)).rows[0];
}

async function main() {
  await app.ready();
  await db.query("DELETE FROM publication_batches WHERE label='导出隔离历史版本' AND source_revision=-190019");
  await db.query("DELETE FROM volunteer_logs WHERE phone='DO-NOT-EXPORT' AND student_id='EXPORT-001'");
  const tokens = {};
  for (const role of ['admin', 'super_admin', 'data_admin', 'college_admin', 'organizer', 'auditor']) {
    const id = crypto.randomUUID();
    await db.query('INSERT INTO users(id,username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5,$6)',
      [id, 'export-' + id, 'not-a-login-credential', '导出隔离验证账号', role, '计算机科学与工程学院']);
    tokens[role] = jwt.sign({ id, session_version: 0, token_type: 'access' }, process.env.JWT_SECRET);
  }
  const call = (query, role = 'admin') => app.inject({ method: 'GET', url: '/api/v1/publications/export' + query,
    headers: role ? { authorization: 'Bearer ' + tokens[role] } : {} });
  assert.equal((await call('', null)).statusCode, 401);
  for (const role of ['data_admin', 'college_admin', 'organizer', 'auditor']) assert.equal((await call('', role)).statusCode, 403);
  assert.equal((await call('?publication_id=invalid')).statusCode, 400);
  assert.equal((await call('?publication_id=' + crypto.randomUUID())).statusCode, 404);
  pass('only administrators and super administrators can export; bad/missing versions are rejected');

  for (const template of manifest.books) {
    const bytes = await fs.readFile(path.join(__dirname, '../templates/publication', template.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), template.sha256);
    const packageFiles = await JSZip.loadAsync(bytes);
    for (const part of Object.values(packageFiles.files).filter(file => !file.dir)) {
      assert(!/(?<![0-9A-Za-z])1(?:1[5-9]|2[0-6])\d{8}(?![0-9A-Za-z])/.test(await part.async('string')),
        'layout-only templates must not retain student-ID constants in metadata');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), template.sheets.map(sheet => sheet.name));
    for (const specification of template.sheets) {
      const sheet = workbook.getWorksheet(specification.name);
      for (const header of specification.headers) assert.equal(sheet.getCell(specification.header_row, header.column).value, header.text);
      sheet.eachRow((row, n) => { if (n > 1) row.eachCell(cell => assert.equal(cell.value, null)); });
    }
  }
  pass('13 sanitized reference workbooks and all 68 original sheet/header layouts are intact');
  assert.deepEqual(manifest.sanitization, { invalid_print_titles: 5, invalid_conditional_rules: 1, source_specific_conditional_rules: 2 });

  const row = (id, properties = {}) => ({ id: crypto.randomUUID(), student_id: id, student_name: '验证样例', college: '计算机科学与工程学院',
    grade: '25级', hours: 0.1, activity_name: '历史活动', created_at: '2026-10-01T00:00:00Z', classified_year: 'legacy', classified_term: 'unassigned', ...properties });
  const fixtures = [
    row('EXPORT-001'), row('EXPORT-001', { hours: 0.2, activity_name: '累计校准', is_adjustment: true }),
    row('EXPORT-001', { hours: 2.5, activity_name: '=HYPERLINK("invalid")', activity_date: '2026-10-01', classified_year: '2026-2027', classified_term: 'upper' }),
    row('EXPORT-002', { hours: -0.1, activity_name: '历史校准扣减', grade: '27级' }),
    row('EXPORT-003', { student_name: '=1+1', college: '重庆知识产权学院', grade: '研25级' }),
    row('EXPORT-004', { college: '数学科学学院', grade: '#REF!' }),
    row('EXPORT-005', { college: '数学科学学院', grade: '#REF!' }),
    row('EXPORT-006', { college: '数学科学学院', grade: '研2024级' }),
  ];
  const fixture = { publication_month: '2026-10', published_at: '2026-10-19T00:00:00Z', snapshot: { records: fixtures,
    rules: { start_month: 9 } } };
  const example = await createArchive(fixture);
  const exampleBooks = await readArchive(example.buffer);
  const people = studentsIn(exampleBooks);
  assert.equal(people.size, 6);
  assert.equal(people.get(JSON.stringify(['EXPORT-001', '验证样例'])).hours, 2.8);
  const currentRow = people.get(JSON.stringify(['EXPORT-001', '验证样例']));
  const currentHeader = currentRow.sheet.getRow(1).values;
  assert.match(currentRow.row.getCell(currentHeader.indexOf('2026-2027上半年活动名')).value, /=HYPERLINK/);
  assert.match(currentRow.row.getCell(currentHeader.indexOf('备注')).value, /历史：历史活动（0.1小时）/);
  assert.equal(people.get(JSON.stringify(['EXPORT-002', '验证样例'])).sheet.name, '27级');
  assert.equal(people.get(JSON.stringify(['EXPORT-002', '验证样例'])).hours, -0.1);
  assert.equal(people.get(JSON.stringify(['EXPORT-004', '验证样例'])).sheet.name, people.get(JSON.stringify(['EXPORT-005', '验证样例'])).sheet.name);
  assert.equal(people.get(JSON.stringify(['EXPORT-006', '验证样例'])).sheet.name, '研24级');
  const notePerson = people.get(JSON.stringify(['EXPORT-003', '=1+1']));
  assert.equal(notePerson.row.getCell(1).type, ExcelJS.ValueType.String);
  assert(notePerson.row.getCell(7).note, 'a reference without remarks retains history in the total cell note');
  assert.deepEqual(example.fallbackColleges, ['数学科学学院']);
  await assert.rejects(createArchive({ ...fixture, snapshot: { records: [row('EXPORT-LONG', { activity_name: '甲'.repeat(32768) })] } }), /长度上限/);
  await assert.rejects(createArchive({ ...fixture, snapshot: { records: [row('EXPORT-CONTROL', { activity_name: 'bad\u0001' })] } }), /控制字符/);
  pass('decimal totals, negative calibration, literal formula text, new/invalid/graduate grades, notes and long cells are handled without loss');

  const fixtureId = crypto.randomUUID();
  await db.query(`INSERT INTO publication_batches(id,publication_month,label,source_revision,record_count,total_hours,snapshot)
    VALUES($1,'2020-09','导出隔离历史版本',-190019,$2,$3,$4)`, [fixtureId, fixtures.length,
    fixtures.reduce((sum, r) => sum + Math.round(r.hours * 10), 0) / 10, fixture.snapshot]);
  // These drafts must not appear in a frozen export, even when approved or containing new identity/contact fields.
  await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,phone,source,status) VALUES
    ('EXPORT-001','验证样例','数学科学学院','26级','未发布通过活动','2026-10-19',999,'DO-NOT-EXPORT','online','approved'),
    ('EXPORT-001','验证样例','数学科学学院','26级','未审核活动','2026-10-19',999,'DO-NOT-EXPORT','online','pending')`);
  const before = await integrity();
  const historic = await call('?publication_id=' + fixtureId, 'super_admin');
  assert.equal(historic.statusCode, 200, historic.body.slice(0, 120));
  assert.equal(historic.headers['x-publication-id'], fixtureId);
  const historicPeople = studentsIn(await readArchive(historic.rawPayload));
  assert.equal(historicPeople.get(JSON.stringify(['EXPORT-001', '验证样例'])).hours, 2.8);
  assert.equal(historicPeople.get(JSON.stringify(['EXPORT-001', '验证样例'])).college, '计算机科学与工程学院');
  assert.match(historic.headers['content-disposition'], /20-21/);
  pass('historical export is pinned to the requested publication; live pending/approved/profile changes cannot leak');

  const start = Date.now();
  const current = (await db.query('SELECT p.* FROM publication_state s JOIN publication_batches p ON p.id=s.publication_id WHERE s.id=true')).rows[0];
  assert(current, 'restore a real published database into the isolated database before this check');
  const response = await call('');
  assert.equal(response.statusCode, 200, response.body.slice(0, 120));
  assert.equal(response.headers['x-publication-id'], current.id);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['content-type'], 'application/zip');
  const realBooks = await readArchive(response.rawPayload);
  const actual = studentsIn(realBooks);
  const expected = (await db.query(`SELECT student_id,student_name,
    (array_agg(NULLIF(btrim(college),'') ORDER BY created_at DESC NULLS LAST,id DESC) FILTER(WHERE NULLIF(btrim(college),'') IS NOT NULL))[1] AS college,
    (array_agg(NULLIF(btrim(grade),'') ORDER BY created_at DESC NULLS LAST,id DESC) FILTER(WHERE NULLIF(btrim(grade),'') IS NOT NULL))[1] AS grade,
    sum(hours) AS hours FROM jsonb_to_recordset($1::jsonb) AS r(id uuid,student_id text,student_name text,college text,grade text,hours numeric,created_at timestamptz)
    GROUP BY student_id,student_name`, [JSON.stringify(current.snapshot.records)])).rows;
  assert.equal(actual.size, expected.length);
  let tenths = 0;
  for (const wanted of expected) {
    const found = actual.get(key(wanted));
    assert(found, 'missing published student');
    assert.equal(Math.round(found.hours * 10), Math.round(Number(wanted.hours) * 10));
    assert.equal(found.college, wanted.college);
    assert.equal(found.grade, wanted.grade || '');
    tenths += Math.round(found.hours * 10);
  }
  assert.equal(tenths, Math.round(Number(current.total_hours) * 10));
  for (const reference of manifest.books) {
    const output = realBooks.find(book => book.name.endsWith(reference.source_file.replace(/\d+\.\d+(?=\.xlsx$)/, `${Number(current.publication_month.slice(5))}月公示`)));
    assert(output, 'missing reference college workbook');
    const template = new ExcelJS.Workbook();
    const templateBytes = await fs.readFile(path.join(__dirname, '../templates/publication', reference.file));
    await template.xlsx.load(templateBytes);
    const expectedPackage = await JSZip.loadAsync(templateBytes), actualPackage = await JSZip.loadAsync(output.raw);
    assert.equal(await actualPackage.file('xl/styles.xml').async('string'), await expectedPackage.file('xl/styles.xml').async('string'));
    for (const [index, specification] of reference.sheets.entries()) {
      const sheet = output.workbook.getWorksheet(specification.name), baseline = template.getWorksheet(specification.name);
      assert(sheet, 'original sheet name must be retained');
      assert.deepEqual(sheet.pageSetup, baseline.pageSetup);
      for (const header of specification.headers) {
        assert.equal(sheet.getCell(1, header.column).value, header.text);
        assert.deepEqual(sheet.getCell(1, header.column).style, baseline.getCell(1, header.column).style);
        assert.equal(sheet.getColumn(header.column).width, baseline.getColumn(header.column).width);
      }
      const expectedXml = await expectedPackage.file(`xl/worksheets/sheet${index + 1}.xml`).async('string');
      const actualXml = await actualPackage.file(`xl/worksheets/sheet${index + 1}.xml`).async('string');
      for (const tag of ['conditionalFormatting', 'dataValidations']) {
        const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'g');
        assert.deepEqual(actualXml.match(pattern), expectedXml.match(pattern), 'reference formatting and validation rules must remain intact');
      }
      if (expectedXml.includes('<autoFilter')) {
        const lastColumn = baseline.getCell(1, Math.max(...specification.headers.map(h => h.column))).address.replace(/\d+$/, '');
        assert.equal(actualXml.match(/<autoFilter\b[^>]*ref="([^"]+)"/)[1], `A1:${lastColumn}${Math.max(2, sheet.rowCount)}`);
      }
    }
  }
  assert.deepEqual(await integrity(), before, 'export must not mutate business records, publication pointers or revisions');
  pass('all real published students reconcile independently to SQL; headers/styles/widths/print settings/conditional formats/validations/filter ranges are preserved');
  const audit = (await db.query("SELECT count(*)::int AS count FROM operation_logs WHERE action='publication.export'")).rows[0].count;
  assert(audit >= 2);
  const evidence = process.env.EXPORT_EVIDENCE_DIR;
  const report = { checks, publication_id: current.id, source_records: current.record_count, students: actual.size,
    workbooks: realBooks.length, hours: tenths / 10, bytes: response.rawPayload.length, elapsed_ms: Date.now() - start,
    archive_sha256: crypto.createHash('sha256').update(response.rawPayload).digest('hex') };
  if (evidence) {
    await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(evidence, 'current-publication.zip'), response.rawPayload, { mode: 0o600 });
    await fs.writeFile(path.join(evidence, 'verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(report));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await app.close(); await db.pool.end(); });
