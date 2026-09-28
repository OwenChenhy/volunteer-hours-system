const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const db = require('../src/db');
const cache = require('../src/cache/redis');
const { buildApp } = require('../src/app');

async function main() {
  const sample = await db.query(`
    SELECT student_id, student_name, college, SUM(hours)::numeric AS total_hours
    FROM volunteer_logs
    WHERE status = 'approved' AND college IS NOT NULL
    GROUP BY student_id, student_name, college
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `);
  assert.equal(sample.rowCount, 1, 'No approved sample exists');
  const other = await db.query(
    `SELECT DISTINCT l.college FROM volunteer_logs l
     WHERE l.college IS NOT NULL AND l.college <> $1
       AND NOT EXISTS (
         SELECT 1 FROM volunteer_logs own
         WHERE own.student_id = $2 AND own.student_name = $3 AND own.college = l.college
       ) LIMIT 1`,
    [sample.rows[0].college, sample.rows[0].student_id, sample.rows[0].student_name],
  );
  assert.equal(other.rowCount, 1, 'No second college exists');

  const app = buildApp();
  app.log.level = 'silent';
  await app.ready();
  const payload = { student_id: sample.rows[0].student_id, student_name: sample.rows[0].student_name };
  const token = (role, org_name) => jwt.sign({ id: 'smoke', role, org_name }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const search = (mode, value, role, org_name) => app.inject({
    method: 'POST',
    url: '/api/v1/admin-search',
    payload: { mode, value },
    headers: { authorization: `Bearer ${token(role, org_name)}` },
  });

  try {
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    const publicQuery = await app.inject({ method: 'POST', url: '/api/v1/query', payload });
    assert.equal(publicQuery.statusCode, 200, 'Public query failed');
    const student = publicQuery.json();
    assert.ok(student.records.length > 0);
    assert.equal(
      Math.round(student.records.reduce((sum, row) => sum + row.hours, 0) * 10) / 10,
      student.total_hours,
      'Record hours do not sum to the public total',
    );

    for (const [mode, value] of [
      ['student_id', payload.student_id],
      ['student_name', payload.student_name],
      ['verification_code', student.verification_code],
    ]) {
      const response = await search(mode, value, 'admin');
      assert.equal(response.statusCode, 200, `${mode} search failed`);
      assert.ok(response.json().total_matches > 0, `${mode} search found no student`);
    }

    const inCollege = await search('student_id', payload.student_id, 'college_admin', sample.rows[0].college);
    assert.equal(inCollege.statusCode, 200);
    assert.equal(inCollege.json().total_matches, 1);
    assert.ok(inCollege.json().matches[0].records.length > 0);
    const outsideCollege = await search('student_id', payload.student_id, 'college_admin', other.rows[0].college);
    assert.equal(outsideCollege.statusCode, 200);
    assert.equal(outsideCollege.json().total_matches, 0);
    const blockedCode = await search('verification_code', student.verification_code, 'college_admin', sample.rows[0].college);
    assert.equal(blockedCode.statusCode, 403);

    const sourceSample = await db.query(`
      SELECT id FROM volunteer_logs
      WHERE source_file IS NOT NULL AND source_sheet IS NOT NULL AND source_row IS NOT NULL
      ORDER BY source_row LIMIT 1
    `);
    assert.equal(sourceSample.rowCount, 1);
    const sourceRow = await app.inject({
      method: 'GET',
      url: `/api/v1/reviews/logs/${sourceSample.rows[0].id}/source-row`,
      headers: { authorization: `Bearer ${token('admin')}` },
    });
    assert.equal(sourceRow.statusCode, 200, 'Original Excel row could not be read');
    assert.ok(sourceRow.json().cells.length > 0);

    console.log(JSON.stringify({ health: 'ok', public_query: 'ok', hour_sum: 'ok', admin_search_modes: 3, college_scope: 'ok', source_row: 'ok' }));
  } finally {
    await app.close();
    await cache.close();
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
