const publication = require('./publicationService');
const db = require('../db');
const crypto = require('crypto');
const academic = require('./academicService');

const LEGACY_PLACEHOLDER_PATTERN = /(源表|未拆分|拆分时长|拆分明细|已拆分|累计未拆分)/;

async function queryStudentLogs(student_id, student_name, college = null, state = null) {
  // 严格比对学号和姓名，去除空格
  const sId = student_id.trim();
  const sName = student_name.trim();
  state = state || await publication.current();
  const rows = (state.people.get(publication.identityKey(sId, sName)) || []).filter(row => !college || row.college === college);
  const progress = (await publication.progress(state, sId, sName)).filter(row => !college || row.college === college);
  if (!rows.length && !progress.length) return null;
  const person = rows[0] || progress[0];
  const dataVersion = publication.meta(state);
  const publishedRows = rows.map(row => ({ ...row, academic_year: row.classified_year, academic_term: row.classified_term }));
  const totalHours = rows.reduce((sum, row) => sum + Math.round(Number(row.hours) * 10), 0) / 10;
  const academicSummaries = academic.summarize(publishedRows);
  for (const summary of academicSummaries) {
    if (!summary.academic_year) continue;
    const cohort = publication.summary(state, { academic_year: summary.academic_year, college: person.college, grade: person.grade, student_id: sId });
    summary.rank = cohort.rows.find((row) => row.student_name === sName)?.rank || null;
    summary.total_students = cohort.total_students;
  }
  const payload = {
    student_id: sId,
    student_name: sName,
    college: person.college,
    grade: person.grade,
    total_hours: totalHours,
    academic_summaries: academicSummaries,
    academic_rules: academic.rules(),
    data_version: dataVersion,
    verification_code: makeVerificationCode(sId, sName, totalHours, rows.length, dataVersion?.batch_id),
    records: publishedRows.map((r, index) => toPublicRecord(r, index)),
    review_progress: progress
  };

  return payload;
}

function toPublicRecord(row, index) {
  const isSummaryRecord = isLegacyPlaceholder(row.activity_name) || isLegacyPlaceholder(row.activity_period);
  const activityPeriod = publicActivityPeriod(row.activity_period);
  const activityDate = formatDate(row.activity_date);

  return {
    id: row.id,
    ...academic.classify(row),
    is_adjustment: Boolean(row.is_adjustment),
    activity_code: `HD-${String(index + 1).padStart(3, '0')}`,
    activity_name: publicActivityName(row.activity_name),
    activity_date: activityDate,
    activity_period: activityPeriod,
    activity_time_label: activityPeriod || activityDate,
    hours: parseFloat(row.hours),
    source: row.source,
    source_label: row.source === 'online' ? '在线记录' : '导入记录',
    imported_at: row.source === 'imported' ? row.created_at : null,
    detail_status: row.import_detail_status || null,
    is_summary_record: isSummaryRecord,
    time_note: isSummaryRecord
      ? '该记录为累计项，未提供单独活动名称或发生日期。'
      : null,
    source_total_hours: row.source_total_hours === null || row.source_total_hours === undefined
      ? null
      : parseFloat(row.source_total_hours)
  };
}

function publicActivityName(value) {
  const text = cleanText(value);
  if (!text || isLegacyPlaceholder(text)) return '累计时长记录';
  return text;
}

function publicActivityPeriod(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (isLegacyPlaceholder(text)) return '累计记录';
  return text;
}

function cleanText(value) {
  return String(value || '').trim();
}

function isLegacyPlaceholder(value) {
  return LEGACY_PLACEHOLDER_PATTERN.test(cleanText(value));
}

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }
  return String(value).split('T')[0];
}

async function getDataVersion() {
  return publication.meta(await publication.current());
}

async function getDraftDataVersion() {
  const version = (await db.query('SELECT revision, updated_at FROM data_versions WHERE id=true')).rows[0];
  return { revision: String(version?.revision || '0'), last_updated_at: version?.updated_at, academic_rules: academic.rules() };
}

async function queryDraftStudentLogs(studentId, studentName, college = null) {
  const params = [studentId.trim(), studentName.trim()];
  if (college) params.push(college);
  const rows = (await db.query(`SELECT id,student_id,student_name,college,grade,academic_year,academic_term,is_adjustment,activity_name,activity_date,activity_period,hours,source,import_detail_status,source_total_hours,created_at
    FROM volunteer_logs WHERE student_id = $1 AND student_name = $2 AND status = 'approved' ${college ? 'AND college = $3' : ''} ORDER BY activity_date DESC,created_at DESC`, params)).rows;
  if (!rows.length) return null;
  const summaries = academic.summarize(rows);
  for (const item of summaries) {
    if (!item.academic_year) continue;
    const scope = await academic.getSummary({ academic_year: item.academic_year, college: rows[0].college, grade: rows[0].grade, student_id: studentId.trim() });
    item.rank = scope.rows.find(row => row.student_name === studentName.trim())?.rank || null;
    item.total_students = scope.total_students;
  }
  const totalHours = rows.reduce((sum, row) => sum + Math.round(Number(row.hours) * 10), 0) / 10;
  const version = await getDraftDataVersion();
  return { student_id: studentId.trim(), student_name: studentName.trim(), college: rows[0].college, grade: rows[0].grade, total_hours: totalHours, academic_summaries: summaries, academic_rules: academic.rules(), data_version: version, verification_code: makeVerificationCode(studentId, studentName, totalHours, rows.length, version.revision), records: rows.map((row, index) => ({ ...toPublicRecord(row, index), activity_name: row.activity_name })) };
}

function makeVerificationCode(studentId, studentName, totalHours, recordCount, batchId) {
  return crypto
    .createHash('sha256')
    .update([studentId, studentName, Number(totalHours).toFixed(1), recordCount, batchId || ''].join('|'))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
}

module.exports = {
  queryStudentLogs,
  queryLogs: queryStudentLogs,
  getDataVersion,
  getDraftDataVersion,
  queryDraftStudentLogs,
  makeVerificationCode,
};
