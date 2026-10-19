const assert = require('node:assert/strict');
const JSZip = require('jszip');
const academic = require('../src/services/academicService');
const { createArchive } = require('../src/services/publicationExportService');
const db = require('../src/db');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/volunteer_period_test_20261019', 'requires the owned period regression database');

(async () => {
  try {
    const fixtures = [
      ['2025-2026上半学年活动名称', '2025-2026', 'upper'],
      ['2025-2026下半学年活动名称', '2025-2026', 'lower'],
      ['2024—2025上半年活动名称', '2024-2025', 'upper'],
      ['2024－2025下半年活动名称', '2024-2025', 'lower'],
      ['2025-2026学年寒暑假补录', '2025-2026', 'vacation'],
      ['寒暑期补录', 'legacy', 'vacation'],
      ['补录寒暑假', 'legacy', 'vacation'],
      ['2018-2019活动名称', '2018-2019', 'unassigned'],
      [null, 'legacy', 'unassigned'],
    ];
    const expr = academic.expressions('l');
    for (const [period, year, term] of fixtures) {
      const row = { activity_name: '分类回归样例', activity_date: null, activity_period: period };
      const category = academic.classify(row);
      assert.equal(category.academic_year, year);
      assert.equal(category.academic_term, term, 'A source category survives without an occurrence date: ' + period);
      const actual = (await db.query(`SELECT ${expr.year} AS academic_year, ${expr.term} AS academic_term
        FROM (SELECT NULL::varchar AS academic_year,NULL::varchar AS academic_term,NULL::date AS activity_date,
          $1::varchar AS activity_period,$2::varchar AS activity_name)l`, [period, row.activity_name])).rows[0];
      assert.deepEqual(actual, { academic_year: year, academic_term: term }, 'SQL and JS agree: ' + period);
    }
    console.log('PASS null occurrence dates preserve all source header variants in SQL and JS');
    const id = require('node:crypto').randomUUID();
    await db.query(`INSERT INTO volunteer_logs(id,student_id,student_name,college,grade,activity_name,activity_date,activity_period,academic_year,academic_term,hours,source,status)
      VALUES($1,'PERIOD-CLEANUP','分类回归样例','计算机科学与工程学院','25级','分类回归样例','2026-01-01','2025-2026上半年活动名称','2025-2026','upper',2,'imported','approved')`, [id]);
    try {
      const result = await require('./normalize-legacy-data').normalize('2099-01-01T00:00:00Z', false);
      assert.equal(result.logs_cleared, 1);
      assert.deepEqual(result.before, result.after, 'Occurrence cleanup must retain every existing source category');
    } finally { await db.query('DELETE FROM volunteer_logs WHERE id=$1', [id]); }
    console.log('PASS the legacy timestamp cleanup preserves source categories and rolls back its dry run');
    const records = [
      { activity_name: '上半年分类样例', activity_period: '2025-2026上半年活动名称', hours: 2 },
      { activity_name: '下半年分类样例', activity_period: '2025-2026下半年活动名称', hours: 3 },
      { activity_name: '假期分类样例', activity_period: '补录寒暑假', hours: 4 },
    ].map(record => ({ ...record, student_id: 'PERIOD-TEST', student_name: '分类样例', college: '计算机科学与工程学院',
      grade: '25级', activity_date: null, record_kind: 'activity', ...Object.fromEntries(Object.entries(academic.classify(record)).filter(([k])=>k.startsWith('academic_'))) }));
    const result = await createArchive({ publication_month: '2026-10', published_at: '2026-10-19T00:00:00Z', snapshot: { records } });
    const archive = await JSZip.loadAsync(result.buffer);
    const workbook = await JSZip.loadAsync(await Object.values(archive.files).find(file=>file.name.endsWith('.xlsx')).async('nodebuffer'));
    const texts = (await Promise.all(Object.values(workbook.files).filter(file=>/^xl\/worksheets\/sheet\d+\.xml$/.test(file.name)).map(file=>file.async('string')))).join('');
    const rows = [...texts.matchAll(/<row\b[^>]*r="2"[^>]*>([\s\S]*?)<\/row>/g)].map(match=>match[1]);
    const row = rows.find(text=>text.includes('PERIOD-TEST'));
    assert(row);
    const cells = new Map([...row.matchAll(/<c\b[^>]*r="([A-Z]+)2"[^>]*>([\s\S]*?)<\/c>/g)].map(match=>[match[1],match[2]]));
    const manifest = require('../templates/publication/manifest.json');
    const specification = manifest.books.find(book=>book.college==='计算机科学与工程学院').sheets.find(sheet=>sheet.name==='25级');
    const column = number => { let name=''; for(;number;number=Math.floor((number-1)/26)) name=String.fromCharCode(65+(number-1)%26)+name; return name; };
    for(const [name,pattern] of [['上半年分类样例',/2025-2026.*上半/],['下半年分类样例',/2025-2026.*下半/],['假期分类样例',/寒|暑/]]) {
      const header=specification.headers.find(header=>pattern.test(header.text));
      assert(cells.get(column(header.column)).includes(name), 'Source detail must return to its original category column: '+name);
    }
    assert(cells.get('G').includes('<v>9</v>'));
    assert(!cells.get(column(specification.headers.find(header=>header.text==='备注').column)).includes('分类样例'));
    console.log('PASS upper/lower/vacation details export separately without dates; totals are counted once');
  } finally { await db.pool.end(); }
})().catch(error=>{ console.error(error); process.exitCode=1; });
