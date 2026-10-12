const db = require('../db');

const TERM_LABELS = { upper: '上半年', lower: '下半年', vacation: '寒暑假补录', unassigned: '待确认累计' };
const UNKNOWN = /(源表|未拆分|累计记录|累计未拆分)/;

function rules() {
  const start = Number(process.env.ACADEMIC_YEAR_START_MONTH || 9);
  if (!Number.isInteger(start) || start < 1 || start > 12) throw new Error('学年起始月份配置无效');
  const months = (name, fallback) => {
    const values = String(process.env[name] || fallback).split(',').map(Number);
    if (values.some((n) => !Number.isInteger(n) || n < 1 || n > 12) || new Set(values).size !== values.length) throw new Error('学期月份配置无效');
    return values;
  };
  const upper = months('ACADEMIC_UPPER_MONTHS', '9,10,11,12,1');
  const vacation = months('ACADEMIC_VACATION_MONTHS', '2,7,8');
  if (upper.some((n) => vacation.includes(n))) throw new Error('假期与学期月份不能重叠');
  return { start_month: start, upper_months: upper, vacation_months: vacation, term_labels: TERM_LABELS };
}

function validYear(value) {
  return /^20\d{2}-20\d{2}$/.test(String(value)) && Number(value.slice(5)) === Number(value.slice(0, 4)) + 1;
}

function validDate(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  const date = new Date(`${text}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function classify(row) {
  const config = rules();
  const text = String(row.activity_period || '');
  const date = row.activity_date instanceof Date ? row.activity_date.toISOString().slice(0, 10) : String(row.activity_date || '').slice(0, 10);
  const month = Number(date.slice(5, 7));
  const year = Number(date.slice(0, 4)) - (month < config.start_month ? 1 : 0);
  const periodYear = text.match(/(20\d{2})\s*[-—]\s*(20\d{2})/);
  const academicYear = row.academic_year || (periodYear ? `${periodYear[1]}-${periodYear[2]}` : `${year}-${year + 1}`);
  let term = row.academic_term;
  if (!term) {
    if (/寒假|暑假|寒暑假|暑期|寒期/.test(text)) term = 'vacation';
    else if (/上半年|上学期|秋季学期/.test(text)) term = 'upper';
    else if (/下半年|下学期|春季学期/.test(text)) term = 'lower';
    else if (!validDate(date) || UNKNOWN.test(String(row.activity_name || '') + text)) term = 'unassigned';
    else if (config.vacation_months.includes(month)) term = 'vacation';
    else term = config.upper_months.includes(month) ? 'upper' : 'lower';
  }
  return { academic_year: validYear(academicYear) ? academicYear : null, academic_term: term, term_label: TERM_LABELS[term] || TERM_LABELS.unassigned };
}

function expressions(alias = 'l') {
  const config = rules();
  const year = `(EXTRACT(YEAR FROM ${alias}.activity_date)::int - CASE WHEN EXTRACT(MONTH FROM ${alias}.activity_date) < ${config.start_month} THEN 1 ELSE 0 END)`;
  const periodYear = `substring(${alias}.activity_period from '(20[0-9]{2}-20[0-9]{2})')`;
  return {
    year: `COALESCE(${alias}.academic_year, ${periodYear}, ${year}::text || '-' || (${year} + 1)::text)`,
    term: `COALESCE(${alias}.academic_term, CASE
      WHEN COALESCE(${alias}.activity_period, '') ~ '(寒假|暑假|寒暑假|暑期|寒期)' THEN 'vacation'
      WHEN COALESCE(${alias}.activity_period, '') ~ '(上半年|上学期|秋季学期)' THEN 'upper'
      WHEN COALESCE(${alias}.activity_period, '') ~ '(下半年|下学期|春季学期)' THEN 'lower'
      WHEN (${alias}.activity_name || COALESCE(${alias}.activity_period, '')) ~ '(源表|未拆分|累计记录|累计未拆分)' THEN 'unassigned'
      WHEN EXTRACT(MONTH FROM ${alias}.activity_date)::int IN (${config.vacation_months.join(',')}) THEN 'vacation'
      WHEN EXTRACT(MONTH FROM ${alias}.activity_date)::int IN (${config.upper_months.join(',')}) THEN 'upper'
      ELSE 'lower' END)`
  };
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const category = classify(record);
    if (!groups.has(category.academic_year)) groups.set(category.academic_year, { academic_year: category.academic_year, upper_hours: 0, lower_hours: 0, vacation_hours: 0, unassigned_hours: 0, total_hours: 0 });
    const group = groups.get(category.academic_year);
    const tenths = Math.round(Number(record.hours || 0) * 10);
    group[`${category.academic_term}_hours`] += tenths;
    group.total_hours += tenths;
  }
  return [...groups.values()].map((group) => Object.fromEntries(Object.entries(group).map(([key, value]) => [key, key.endsWith('_hours') ? value / 10 : value]))).sort((a, b) => String(b.academic_year).localeCompare(String(a.academic_year)));
}

async function getSummary(options = {}) {
  if (!validYear(options.academic_year)) throw new Error('学年必须为连续的 YYYY-YYYY');
  const expr = expressions();
  const params = [options.academic_year];
  let where = `${expr.year} = $1`;
  for (const key of ['college', 'grade']) {
    if (options[key]) { params.push(options[key]); where += ` AND l.${key} = $${params.length}`; }
  }
  let selected = '';
  if (options.student_id) { params.push(options.student_id); selected = `WHERE student_id = $${params.length}`; }
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 50)));
  params.push(limit, (page - 1) * limit);
  const result = await db.query(`WITH classified AS (
    SELECT l.student_id, l.student_name, l.college, l.grade, l.hours, ${expr.term} AS term
    FROM volunteer_logs l WHERE l.status = 'approved' AND ${where}
  ), totals AS (
    SELECT student_id, student_name, college, grade,
      COALESCE(SUM(hours) FILTER (WHERE term = 'upper'), 0) AS upper_hours,
      COALESCE(SUM(hours) FILTER (WHERE term = 'lower'), 0) AS lower_hours,
      COALESCE(SUM(hours) FILTER (WHERE term = 'vacation'), 0) AS vacation_hours,
      COALESCE(SUM(hours) FILTER (WHERE term = 'unassigned'), 0) AS unassigned_hours,
      SUM(hours) AS total_hours
    FROM classified GROUP BY student_id, student_name, college, grade
  ), ranked AS (
    SELECT *, DENSE_RANK() OVER (ORDER BY total_hours DESC) AS rank,
      COUNT(*) OVER () AS total_students FROM totals
  ) SELECT * FROM ranked ${selected}
    ORDER BY total_hours DESC, student_id, student_name, college, grade
    LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  let totalStudents = Number(result.rows[0]?.total_students || 0);
  if (!result.rows.length && (page > 1 || options.student_id)) totalStudents = (await getSummary({ ...options, student_id: undefined, page: 1, limit: 1 })).total_students;
  return { academic_year: options.academic_year, page, limit, total_students: totalStudents, rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key.endsWith('_hours') || key === 'rank' || key === 'total_students' ? Number(value) : value]))) };
}

module.exports = { TERM_LABELS, rules, validYear, validDate, classify, summarize, expressions, getSummary };
