const fs = require('node:fs/promises');
const path = require('node:path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const academic = require('./academicService');
const { isHistoricalBalance } = require('./hourRecordService');
const { normalizeCollegeName } = require('../utils/collegeNames');
const manifest = require('../../templates/publication/manifest.json');
const templateDirectory = path.join(__dirname, '../../templates/publication');
const fallback = manifest.books.find(book => book.college === '计算机科学与工程学院');
const clone = value => JSON.parse(JSON.stringify(value));
const identity = row => JSON.stringify([row.student_id, row.student_name]);
const safeName = value => String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
const failure = message => Object.assign(new Error(message), { statusCode: 422 });
const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function xml(value) {
  const text = String(value);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw failure('公示内容含Excel不支持的控制字符，请先核对原记录');
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}
function columnName(number) {
  let text = '';
  for (; number; number = Math.floor((number - 1) / 26)) text = String.fromCharCode(65 + (number - 1) % 26) + text;
  return text;
}

function gradeKey(value) {
  const text = String(value || '').replace(/\s/g, '');
  const year = text.match(/20(\d{2})|(?:^|\D)(\d{2})(?:级|$)/);
  const kind = /二学位/.test(text) ? 'second' : /研|硕/.test(text) ? 'graduate' : 'undergraduate';
  return { kind, year: year?.[1] || year?.[2] || '', text };
}

function matchingSheet(sheets, grade) {
  const wanted = gradeKey(grade);
  return sheets.find(sheet => sheet.headers.length && gradeKey(sheet.name).text === wanted.text)
    || sheets.find(sheet => {
      const current = gradeKey(sheet.name);
      return sheet.headers.length && current.kind === wanted.kind && current.year && current.year === wanted.year;
    })
    || sheets.find(sheet => sheet.headers.length && gradeKey(sheet.name).kind === wanted.kind
      && !gradeKey(sheet.name).year && /研究生|二学位/.test(sheet.name));
}

async function addGradeSheet(workbook, specifications, grade) {
  const wanted = gradeKey(grade);
  const prototype = [...specifications].reverse().find(sheet => sheet.headers.length && gradeKey(sheet.name).kind === wanted.kind)
    || [...specifications].reverse().find(sheet => sheet.headers.length);
  let name = safeName(wanted.text && !/^#/.test(wanted.text) ? wanted.text : '年级待核对').replace(/[\[\]]/g, '_').slice(0, 27);
  const base = name;
  for (let n = 2; specifications.some(sheet => sheet.name === name); n++) name = `${base}-${n}`;
  const number = specifications.length + 1;
  const specification = { ...prototype, name, path: `xl/worksheets/sheet${number}.xml` };
  workbook.file(specification.path, await workbook.file(prototype.path).async('string'));
  const bookXml = await workbook.file('xl/workbook.xml').async('string');
  workbook.file('xl/workbook.xml', bookXml.replace('</sheets>', `<sheet name="${xml(name)}" sheetId="${number}" r:id="rId${number}"/></sheets>`));
  const relationships = await workbook.file('xl/_rels/workbook.xml.rels').async('string');
  workbook.file('xl/_rels/workbook.xml.rels', relationships.replace('</Relationships>', `<Relationship Id="rId${number}" Type="${relationshipNamespace}/worksheet" Target="worksheets/sheet${number}.xml"/></Relationships>`));
  const types = await workbook.file('[Content_Types].xml').async('string');
  workbook.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${specification.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));
  specifications.push(specification);
  return specification;
}

function periodColumn(headers, record) {
  // Unknown historical dates never inherit an activity column's semester label.
  const year = record.classified_year || record.academic_year;
  const term = record.classified_term || record.academic_term;
  if (!academic.validYear(year) || !['upper', 'lower', 'vacation'].includes(term)) return null;
  const matchesTerm = text => term === 'vacation' ? /寒|暑/.test(text)
    : term === 'upper' ? /上半|上学期/.test(text) : /下半|下学期/.test(text);
  const exact = headers.find(header => header.text.replace(/\s/g, '').includes(year) && matchesTerm(header.text));
  return exact?.column || (term === 'vacation' ? headers.find(header => !/20\d{2}/.test(header.text) && matchesTerm(header.text))?.column : null);
}

function detail(record) {
  const hours = Number(record.hours);
  if (!Number.isFinite(hours)) throw failure('公示中存在无效时长，请先核对该公示版本');
  const date = record.activity_date ? String(record.activity_date).slice(0, 10) + ' ' : '';
  return `${date}${record.activity_name || '历史累计记录'}（${Math.round(hours * 10) / 10}小时）`;
}

function personCells(specification, person) {
  const headers = specification.headers;
  const fields = { 姓名: person.student_name, 名字: person.student_name, 性别: '', 学院: person.college,
    年级: person.grade || '', 学号: String(person.student_id), 联系方式: '', 电话: '', 联系电话: '' };
  const values = new Map(), notes = [];
  for (const record of person.records) {
    if (isHistoricalBalance(record)) {
      notes.push(record.import_detail_status==='cumulative_reconciliation'
        ? `成绩单核定累计：${Number(record.source_total_hours)}小时；与保留明细的差额${Number(record.hours)}小时已计入总时长（非活动）。`
        : `原表累计项：${Number(record.hours)}小时，已计入总时长（未提供活动名称）。`);
      continue;
    }
    const column = periodColumn(headers, record);
    if (column) {
      if (!values.has(column)) values.set(column, []);
      values.get(column).push(detail(record));
    } else {
      const year = record.classified_year || record.academic_year;
      const label = academic.validYear(year) ? `${year}${academic.TERM_LABELS[record.classified_term || record.academic_term] || '未分期'}：` : '历史：';
      notes.push(label + detail(record));
    }
  }
  const remarks = headers.find(header => header.text.trim() === '备注');
  let totalColumn;
  const cells = [];
  for (const header of headers) {
    const label = header.text.trim();
    let value;
    if (/服务时长|志愿时长/.test(label)) {
      value = person.tenths / 10;
      totalColumn = header.column;
    } else if (Object.hasOwn(fields, label)) value = fields[label];
    else value = header === remarks ? notes.join('\n') : (values.get(header.column) || []).join('\n');
    if (typeof value === 'string' && value.length > 32767) {
      throw failure('有学生的活动明细超过Excel单元格长度上限，未截断数据，请联系管理员核对');
    }
    cells.push({ column: header.column, value });
  }
  return { cells, note: !remarks && notes.length && totalColumn ? { column: totalColumn, text: notes.join('\n') } : null };
}

async function fillSheet(workbook, specification, people) {
  if (!people.length) return;
  let sheetXml = await workbook.file(specification.path).async('string');
  const data = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/)[1];
  const originalRows = [...data.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g)].map(match => match[0]);
  const header = originalRows[0];
  const prototype = originalRows[1] || '<row r="2"></row>';
  const attributes = prototype.match(/^<row\b([^>]*?)(?:\/?>)/)[1].replace(/\s+r="\d+"|\s+spans="[^"]*"/g, '');
  const styles = new Map();
  for (const cell of prototype.matchAll(/<c\b([^>]*?)(?:\/?>)/g)) {
    const name = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1], style = cell[1].match(/\bs="(\d+)"/)?.[1];
    if (name && style) styles.set(name, style);
  }
  const notes = [], rows = [];
  for (let index = 0; index < people.length; index++) {
    const number = specification.header_row + index + 1;
    const person = personCells(specification, people[index]);
    const cells = person.cells.map(({ column, value }) => {
      const name = columnName(column), reference = name + number;
      const style = styles.has(name) ? ` s="${styles.get(name)}"` : '';
      return typeof value === 'number' ? `<c r="${reference}"${style}><v>${value}</v></c>`
        : `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('');
    rows.push(`<row r="${number}"${attributes}>${cells}</row>`);
    if (person.note) notes.push({ cell: columnName(person.note.column) + number, text: person.note.text });
  }
  sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${header}${rows.join('')}</sheetData>`);
  sheetXml = sheetXml.replace(/(<autoFilter\b[^>]*\bref=")[^"]*"/, `$1A1:${columnName(Math.max(...specification.headers.map(header => header.column)))}${specification.header_row + people.length}"`);
  if (notes.length) {
    // ExcelJS only creates the note parts; the reference worksheet/styles/print settings stay untouched.
    const noteBook = new ExcelJS.Workbook(), noteSheet = noteBook.addWorksheet('Notes');
    for (const note of notes) noteSheet.getCell(note.cell).note = note.text;
    const parts = await JSZip.loadAsync(await noteBook.xlsx.writeBuffer());
    const number = Number(specification.path.match(/sheet(\d+)\.xml$/)[1]);
    workbook.file(`xl/comments${number}.xml`, await parts.file('xl/comments1.xml').async('nodebuffer'));
    workbook.file(`xl/drawings/vmlDrawing${number}.vml`, await parts.file('xl/drawings/vmlDrawing1.vml').async('nodebuffer'));
    workbook.file(`xl/worksheets/_rels/sheet${number}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNotes" Type="${relationshipNamespace}/comments" Target="../comments${number}.xml"/><Relationship Id="rIdNotesVml" Type="${relationshipNamespace}/vmlDrawing" Target="../drawings/vmlDrawing${number}.vml"/></Relationships>`);
    let types = await workbook.file('[Content_Types].xml').async('string');
    if (!types.includes('Extension="vml"')) types = types.replace('</Types>', '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/></Types>');
    workbook.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/xl/comments${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>`));
    sheetXml = sheetXml.replace('</worksheet>', `<legacyDrawing xmlns:r="${relationshipNamespace}" r:id="rIdNotesVml"/></worksheet>`);
  }
  workbook.file(specification.path, sheetXml);
}

async function createArchive(batch) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(batch.publication_month)) throw failure('公示月份无效');
  if (!Array.isArray(batch.snapshot?.records)) throw failure('公示快照不可用');
  const records = batch.snapshot.records;
  if (records.some(record => !Number.isFinite(Number(record.hours)))) throw failure('公示中存在无效时长，请先核对该公示版本');
  const people = new Map();
  for (const total of academic.publicationTotals(records)) {
    const key = identity(total);
    if (!people.has(key)) people.set(key, { ...total, college: normalizeCollegeName(total.college) || '学院待核对', tenths: 0, records: [] });
    people.get(key).tenths += Math.round(Number(total.total_hours) * 10);
  }
  for (const record of records) people.get(identity(record)).records.push(record);
  const colleges = new Map();
  for (const person of people.values()) {
    if (!colleges.has(person.college)) colleges.set(person.college, []);
    colleges.get(person.college).push(person);
  }
  const [calendarYear, month] = batch.publication_month.split('-').map(Number);
  const startYear = calendarYear - (month < (batch.snapshot.rules?.start_month || 9) ? 1 : 0);
  const folder = `${String(startYear).slice(-2)}-${String(startYear + 1).slice(-2)}年${month}月时长库`;
  const archive = new JSZip();
  const fallbackColleges = [];
  let sheetCount = 0;
  for (const [college, students] of [...colleges].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))) {
    const reference = manifest.books.find(book => book.college === college);
    const template = reference || fallback;
    if (!reference) fallbackColleges.push(college);
    const workbook = await JSZip.loadAsync(await fs.readFile(path.join(templateDirectory, template.file)));
    const specifications = clone(template.sheets).map((sheet, index) => ({ ...sheet, path: `xl/worksheets/sheet${index + 1}.xml` }));
    const sheetPeople = new Map();
    const assignments = new Map();
    const singleSheet = specifications.filter(sheet => sheet.headers.length).length === 1 && specifications.length === 1;
    students.sort((a, b) => b.tenths - a.tenths || String(a.student_id).localeCompare(String(b.student_id)) || a.student_name.localeCompare(b.student_name, 'zh-CN'));
    for (const person of students) {
      const key = gradeKey(person.grade).text;
      if (!assignments.has(key)) assignments.set(key, (singleSheet ? specifications[0] : matchingSheet(specifications, person.grade))
        || await addGradeSheet(workbook, specifications, person.grade));
      const sheet = assignments.get(key);
      if (!sheetPeople.has(sheet.name)) sheetPeople.set(sheet.name, []);
      sheetPeople.get(sheet.name).push(person);
    }
    for (const specification of specifications) {
      if (!specification.headers.length) continue;
      const rows = sheetPeople.get(specification.name) || [];
      await fillSheet(workbook, specification, rows);
    }
    const filename = reference ? reference.source_file.replace(/\d+\.\d+(?=\.xlsx$)/, `${month}月公示`)
      : `${college}志愿者信息汇总表${month}月公示.xlsx`;
    archive.file(`${folder}/${safeName(filename)}`, await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { date: new Date(batch.published_at) });
    sheetCount += specifications.length;
  }
  return { buffer: await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    filename: folder + '.zip', studentCount: people.size, recordCount: records.length,
    workbookCount: colleges.size, sheetCount, fallbackColleges };
}

module.exports = { createArchive };
