const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
assert.equal(new URL(process.env.DATABASE_URL || '').pathname, '/volunteer_review_fix_test_20261019', 'Dedicated isolated database required');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const app = buildApp();
app.log.level = 'silent';
const ids = [];

(async () => {
  try {
    await app.ready();
    const admin = (await db.query("SELECT id,session_version FROM users WHERE role='super_admin' AND deleted_at IS NULL LIMIT 1")).rows[0];
    assert(admin);
    const token = jwt.sign({ id: admin.id, session_version: admin.session_version, token_type: 'access' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const get = async url => {
      const result = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      assert.equal(result.statusCode, 200, url + ': ' + result.body.slice(0, 160));
      return result.json();
    };
    const prefix = 'REVIEWFIX-' + crypto.randomUUID().slice(0, 8);
    const add = async (suffix, status, flag = false) => {
      const id = crypto.randomUUID(); ids.push(id);
      const student = prefix + '-' + suffix;
      await db.query(`INSERT INTO volunteer_logs(id,student_id,student_name,college,grade,activity_name,hours,source,status,import_detail_status,is_legacy_processed)
        VALUES($1,$2,'复核回归夹具','计算机科学与工程学院','26级','复核回归夹具',2.5,'imported','approved',$3,$4)`, [id, student, status, flag]);
      return { id, student };
    };
    const confirmed = await add('confirm', 'summary_conflict');
    const archived = await add('archive', 'summary_no_detail');
    const future = await add('future', 'summary_conflict');
    await add('calibration', 'cumulative_reconciliation');
    await add('balance', 'unresolved_balance');
    await add('legacy-flag', 'summary_conflict', true);
    const before = (await db.query(`SELECT md5(string_agg(to_jsonb(l)::text,'' ORDER BY id)) AS digest FROM volunteer_logs l`)).rows[0];
    const version = (await db.query('SELECT * FROM data_versions')).rows;
    const publication = (await db.query('SELECT * FROM publication_state')).rows;
    for (const [row, action] of [[confirmed, 'confirm_processed'], [archived, 'archive_out_of_scope']]) {
      await db.query("INSERT INTO review_notes(log_id,user_id,action,detail) VALUES($1,$2,$3,$4)", [row.id, admin.id, action, { note: 'Synthetic closure fixture, no source record was edited' }]);
    }
    await db.query("INSERT INTO review_notes(log_id,user_id,action,detail) VALUES($1,$2,'update',$3)", [future.id, admin.id, { note: 'A comment is not a closure' }]);
    const only = (type, row) => `/api/v1/reviews/problem-logs?type=${type}&student_id=${encodeURIComponent(row.student)}&limit=1000`;
    assert.equal((await get(only('unprocessed', confirmed))).length, 0, 'Closure audit must remove the completed row from the unprocessed queue');
    assert.equal((await get(only('unprocessed', archived))).length, 0, 'Scope archive must not become a pending conflict');
    assert.equal((await get(only('reviewed', confirmed)))[0].is_legacy_processed, true);
    assert.equal((await get(only('archived_out_of_scope', archived)))[0].review_resolution, 'archived_out_of_scope');
    assert.equal((await get(only('unprocessed', future))).length, 1, 'A new genuine conflict must remain open');
    const open = await get('/api/v1/reviews/problem-logs?type=unprocessed&limit=1000');
    const overview = await get('/api/v1/stats/overview');
    assert.equal(Number(overview.legacy_todo_count), open.length, 'Dashboard must count actionable issues, not all imported records');
    const legacy = await get('/api/v1/logs?legacy_unprocessed=true&limit=1000');
    assert.deepEqual(legacy.map(row => row.id).sort(), open.map(row => row.id).sort());
    const distribution = (await get('/api/v1/stats/problems')).by_status;
    assert(Number(distribution.find(row => row.problem_type === 'reviewed').record_count) >= 2);
    assert(Number(distribution.find(row => row.problem_type === 'archived_out_of_scope').record_count) >= 1);
    assert.deepEqual((await db.query(`SELECT md5(string_agg(to_jsonb(l)::text,'' ORDER BY id)) AS digest FROM volunteer_logs l`)).rows[0], before);
    assert.deepEqual((await db.query('SELECT * FROM data_versions')).rows, version);
    assert.deepEqual((await db.query('SELECT * FROM publication_state')).rows, publication);
    console.log('PASS explicit review closures and scope archives agree across queue, filters, distribution, dashboard and list API; fresh conflicts remain open; business records, data version and publication are unchanged');
  } finally {
    if (ids.length) await db.query('DELETE FROM volunteer_logs WHERE id=ANY($1::uuid[])', [ids]);
    await app.close();
    await db.pool.end();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
