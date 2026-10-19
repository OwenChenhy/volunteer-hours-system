const db = require('../db');
const { profilesCTE } = require('./academicService');
const { reviewState } = require('./reviewState');

async function getOverview() {
  const stats = await db.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
      COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
      COUNT(*) FILTER (WHERE ${reviewState('l').open}) as legacy_todo_count,
      COALESCE(SUM(hours) FILTER (WHERE status = 'approved'), 0) as total_hours,
      COUNT(*) as total_records,
      COUNT(DISTINCT student_id) FILTER (WHERE status = 'approved') as total_students,
      COUNT(DISTINCT COALESCE(activity_id::text, activity_name)) FILTER (WHERE status = 'approved' AND record_kind='activity') as activity_count
    FROM volunteer_logs l WHERE status IN ('pending','approved','rejected')
  `);
  return stats.rows[0];
}

async function getByCollege() {
  const result = await db.query(`
    WITH ${profilesCTE()}
    SELECT p.college, SUM(l.hours) as total_hours, COUNT(*) as record_count
    FROM volunteer_logs l JOIN profiles p USING(student_id,student_name)
    WHERE l.status = 'approved'
    GROUP BY p.college
    ORDER BY total_hours DESC
  `);
  return result.rows;
}

async function getByMonth() {
  const result = await db.query(`
    SELECT CASE WHEN record_kind<>'activity' THEN '历史累计核定'
           WHEN activity_date IS NULL THEN '未注明具体月份'
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
      WITH ${profilesCTE()}
      SELECT l.student_id, l.student_name, p.college,
             SUM(l.hours) AS total_hours,
             COUNT(*) AS record_count
      FROM volunteer_logs l JOIN profiles p USING(student_id,student_name)
      WHERE l.status = 'approved'
      GROUP BY l.student_id, l.student_name, p.college
      ORDER BY total_hours DESC
      LIMIT 50
    `),
    db.query(`
      SELECT activity_name,
             SUM(hours) AS total_hours,
             COUNT(*) AS record_count,
             COUNT(DISTINCT student_id) AS student_count
      FROM volunteer_logs
      WHERE status = 'approved' AND record_kind='activity'
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
  const state = reviewState('l');
  const classified = `WITH classified AS (SELECT l.*, ${state.type} AS review_type FROM volunteer_logs l)`;
  const [byStatus, trend] = await Promise.all([
    db.query(`
      ${classified}
      SELECT review_type AS problem_type,
             COUNT(*) AS record_count,
             COALESCE(SUM(hours), 0) AS total_hours
      FROM classified
      WHERE source = 'imported' AND status IN ('pending','approved','rejected')
      GROUP BY review_type
      ORDER BY record_count DESC
    `),
    db.query(`
      ${classified}
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             review_type AS problem_type,
             COUNT(*) AS record_count
      FROM classified
      WHERE source = 'imported' AND status IN ('pending','approved','rejected')
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
