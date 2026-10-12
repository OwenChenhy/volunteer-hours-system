const db = require('../db');
const { LEGACY_LABEL } = require('./academicService');

async function getOverview() {
  const stats = await db.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
      COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
      COUNT(*) FILTER (WHERE source = 'imported' AND is_legacy_processed = false) as legacy_todo_count,
      COALESCE(SUM(hours) FILTER (WHERE status = 'approved'), 0) as total_hours,
      COUNT(*) as total_records,
      COUNT(DISTINCT student_id) FILTER (WHERE status = 'approved') as total_students,
      COUNT(DISTINCT COALESCE(activity_id::text, activity_name)) FILTER (WHERE status = 'approved') as activity_count
    FROM volunteer_logs
  `);
  return stats.rows[0];
}

async function getByCollege() {
  const result = await db.query(`
    SELECT college, SUM(hours) as total_hours, COUNT(*) as record_count
    FROM volunteer_logs
    WHERE status = 'approved'
    GROUP BY college
    ORDER BY total_hours DESC
  `);
  return result.rows;
}

async function getByMonth() {
  const result = await db.query(`
    SELECT CASE WHEN activity_date IS NULL THEN '${LEGACY_LABEL}'
           ELSE to_char(date_trunc('month', activity_date), 'YYYY-MM') END as month,
           SUM(hours) as total_hours,
           COUNT(*) as record_count
    FROM volunteer_logs
    WHERE status = 'approved'
    GROUP BY month
    ORDER BY month DESC
  `);
  return result.rows;
}

async function getRankings() {
  const [studentTop, activityTop, collegeTop] = await Promise.all([
    db.query(`
      SELECT student_id, student_name, college,
             SUM(hours) AS total_hours,
             COUNT(*) AS record_count
      FROM volunteer_logs
      WHERE status = 'approved'
      GROUP BY student_id, student_name, college
      ORDER BY total_hours DESC
      LIMIT 50
    `),
    db.query(`
      SELECT activity_name,
             SUM(hours) AS total_hours,
             COUNT(*) AS record_count,
             COUNT(DISTINCT student_id) AS student_count
      FROM volunteer_logs
      WHERE status = 'approved'
      GROUP BY activity_name
      ORDER BY record_count DESC, total_hours DESC
      LIMIT 50
    `),
    getByCollege(),
  ]);

  return {
    students: studentTop.rows,
    activities: activityTop.rows,
    colleges: collegeTop,
  };
}

async function getProblemStats() {
  const [byStatus, trend] = await Promise.all([
    db.query(`
      SELECT COALESCE(import_detail_status, 'normal') AS problem_type,
             COUNT(*) AS record_count,
             COALESCE(SUM(hours), 0) AS total_hours
      FROM volunteer_logs
      WHERE source = 'imported'
      GROUP BY COALESCE(import_detail_status, 'normal')
      ORDER BY record_count DESC
    `),
    db.query(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             COALESCE(import_detail_status, 'normal') AS problem_type,
             COUNT(*) AS record_count
      FROM volunteer_logs
      WHERE source = 'imported'
      GROUP BY day, problem_type
      ORDER BY day DESC, problem_type
      LIMIT 120
    `),
  ]);

  return {
    by_status: byStatus.rows,
    trend: trend.rows,
  };
}

module.exports = {
  getOverview,
  getByCollege,
  getByMonth,
  getRankings,
  getProblemStats,
  getStatsByCollege: getByCollege
};
