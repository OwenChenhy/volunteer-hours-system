const db = require('../db');
const cache = require('../cache/redis');
const crypto = require('crypto');

const LEGACY_PLACEHOLDER_PATTERN = /(源表|未拆分|拆分时长|拆分明细|已拆分|累计未拆分)/;

async function queryStudentLogs(student_id, student_name, college = null) {
  // 严格比对学号和姓名，去除空格
  const sId = student_id.trim();
  const sName = student_name.trim();
  const cacheKey = `query:v3:${sId}:${sName}:${college || ''}`;

  const cached = await cache.getJson(cacheKey);
  if (cached) return cached;

  const collegeFilter = college ? 'AND college = $3' : '';
  const query = `
    SELECT 
      student_id, student_name, college, grade,
      activity_name, activity_date, activity_period, hours, source,
      import_detail_status, source_total_hours, created_at
    FROM volunteer_logs
    WHERE student_id = $1 AND student_name = $2 AND status = 'approved'
      ${collegeFilter}
    ORDER BY activity_date DESC, created_at DESC
  `;

  const result = await db.query(query, college ? [sId, sName, college] : [sId, sName]);
  
  if (result.rows.length === 0) return null;

  const totalHours = Math.round(result.rows.reduce((sum, row) => sum + parseFloat(row.hours), 0) * 10) / 10;
  
  const dataVersion = await getDataVersion();
  const payload = {
    student_id: result.rows[0].student_id,
    student_name: result.rows[0].student_name,
    college: result.rows[0].college,
    grade: result.rows[0].grade,
    total_hours: totalHours,
    data_version: dataVersion,
    verification_code: makeVerificationCode(sId, sName, totalHours, result.rows.length, dataVersion?.batch_id),
    records: result.rows.map((r, index) => toPublicRecord(r, index))
  };

  await cache.setJson(cacheKey, payload, 300);
  return payload;
}

function toPublicRecord(row, index) {
  const isSummaryRecord = isLegacyPlaceholder(row.activity_name) || isLegacyPlaceholder(row.activity_period);
  const activityPeriod = publicActivityPeriod(row.activity_period);
  const activityDate = formatDate(row.activity_date);

  return {
    activity_code: `HD-${String(index + 1).padStart(3, '0')}`,
    activity_name: publicActivityName(row.activity_name),
    activity_date: activityDate,
    activity_period: activityPeriod,
    activity_time_label: activityPeriod || activityDate,
    hours: parseFloat(row.hours),
    source: row.source,
    source_label: row.source === 'online' ? '在线记录' : '导入记录',
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
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }
  return String(value).split('T')[0];
}

async function getDataVersion() {
  const result = await db.query(`
    SELECT id AS batch_id, filename, note, record_count, created_at
    FROM import_batches
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const batch = result.rows[0];
  if (!batch) {
    return {
      source_name: '暂无导入批次',
      last_updated_at: null,
      note: null,
      record_count: 0,
    };
  }
  return {
    source_name: batch.note || batch.filename,
    batch_id: batch.batch_id,
    filename: batch.filename,
    note: batch.note,
    record_count: batch.record_count,
    last_updated_at: batch.created_at,
    precision_note: '项目数据来源于公示时长库，查询时长仅供参考',
  };
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
  makeVerificationCode,
};
