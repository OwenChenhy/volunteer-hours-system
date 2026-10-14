const assert = require('node:assert/strict');
const db = require('../src/db');
const publication = require('../src/services/publicationService');
const { LEGACY_LABEL } = require('../src/services/academicService');
const { normalizeCollegeName, isFormalCollegeName } = require('../src/utils/collegeNames');

async function integrity(executor) {
  return (await executor.query(`SELECT count(*)::int AS records, sum(hours)::text AS hours,
    count(*) FILTER (WHERE status='approved')::int AS approved,
    md5(string_agg(concat_ws('|',id,hours,status,student_id,student_name,grade,created_at), '\n' ORDER BY id)) AS identity_hours_hash
    FROM volunteer_logs`)).rows[0];
}

async function normalize(cutoff, apply = false) {
  assert(!Number.isNaN(Date.parse(cutoff)), 'a fixed pre-release cutoff is required');
  const client = await db.pool.connect();
  const result = { cutoff, dry_run: !apply, college_updates: [] };
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(927641)');
    await client.query('LOCK TABLE volunteer_logs, activities, users IN SHARE ROW EXCLUSIVE MODE');
    result.before = await integrity(client);
    const owner = (await client.query("SELECT id FROM users WHERE username='admin' AND is_active=true")).rows[0];
    assert(owner, 'active system owner is required');
    const pending = (await client.query("SELECT count(*)::int AS count FROM volunteer_logs WHERE status='pending'")).rows[0].count;
    assert.equal(pending, 0, 'review pending records before updating the published baseline');
    for (const [table, column] of [['volunteer_logs', 'college'], ['activities', 'org_name'], ['users', 'org_name']]) {
      const values = (await client.query(`SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column}<>''`)).rows;
      for (const {value} of values) {
        const formal = normalizeCollegeName(value);
        if (!isFormalCollegeName(formal)) {
          assert.notEqual(table, 'volunteer_logs', 'unknown college must be resolved before cleanup');
          continue;
        }
        if (formal === value) continue;
        const updated = await client.query(`UPDATE ${table} SET ${column}=$1 WHERE ${column}=$2`, [formal, value]);
        result.college_updates.push({table, from: value, to: formal, records: updated.rowCount});
      }
    }
    result.logs_cleared = (await client.query(`UPDATE volunteer_logs SET activity_date=NULL, activity_period=$1,
      academic_year=NULL, academic_term='unassigned' WHERE created_at <= $2::timestamptz`, [LEGACY_LABEL, cutoff])).rowCount;
    result.activities_cleared = (await client.query(`UPDATE activities SET start_time=NULL, end_time=NULL,
      academic_year=NULL, academic_term='unassigned',
      location=CASE WHEN COALESCE(location,'') ~ '(20[0-9]{2}|上半|下半|寒假|暑假|累计)' THEN NULL ELSE location END
      WHERE created_at <= $1::timestamptz`, [cutoff])).rowCount;
    result.after = await integrity(client);
    assert.deepEqual(result.after, result.before, 'record count, identity, hours, status and import timestamps must not change');
    if (apply) {
      await client.query(`INSERT INTO operation_logs(user_id,username,action,target_type,detail,ip)
        VALUES($1,'admin','data.normalize_legacy','volunteer_library',$2,'127.0.0.1')`, [owner.id, result]);
      await client.query('COMMIT');
      const state = await publication.publish(owner.id, {publication_month: '2026-10', label: LEGACY_LABEL});
      result.publication_id = state.batch.id;
      result.published_records = state.batch.record_count;
      result.published_hours = Number(state.batch.total_hours);
    } else {
      await client.query('ROLLBACK');
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
}

module.exports = {normalize, integrity};
if (require.main === module) {
  const cutoff = process.argv.find(value => value.startsWith('--cutoff='))?.slice('--cutoff='.length);
  normalize(cutoff, process.argv.includes('--apply')).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {console.error(JSON.stringify({error: error.code || error.name})); process.exitCode=1;})
    .finally(() => db.pool.end());
}
