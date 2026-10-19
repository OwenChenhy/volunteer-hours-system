const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
assert.equal(new URL(process.env.DATABASE_URL || '').pathname, '/volunteer_balance_test_20261019', 'Dedicated isolated database required');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const query = require('../src/services/queryService');
const publication = require('../src/services/publicationService');
const { createArchive } = require('../src/services/publicationExportService');
const JSZip = require('jszip');
const app = buildApp(); app.log.level = 'silent';
let fixtureStudent, fixtureActivity, fixturePublication, priorPublication;
(async () => {
  try {
    await app.ready();
    const sample = (await db.query("SELECT student_id,student_name FROM volunteer_logs WHERE import_detail_status='cumulative_reconciliation' ORDER BY hours LIMIT 1")).rows[0];
    assert(sample, 'Restored cumulative cohort required');
    const first = await query.queryStudentLogs(sample.student_id, sample.student_name);
    assert(!first.records.some(row => row.detail_status === 'cumulative_reconciliation'), 'Transcript differences must not be returned as activities');
    assert(first.historical_balances?.length, 'The approved historical cumulative basis must remain separate');
    const admin = (await db.query("SELECT id,session_version FROM users WHERE role='super_admin' AND deleted_at IS NULL LIMIT 1")).rows[0];
    const token = jwt.sign({id:admin.id,session_version:admin.session_version,token_type:'access'},process.env.JWT_SECRET,{expiresIn:'5m'});
    async function call(method,url,payload,status=200) {
      const response = await app.inject({method,url,payload,headers:{authorization:`Bearer ${token}`}});
      assert.equal(response.statusCode,status,url+': '+response.body.slice(0,120));
      return response.json();
    }
    const publicResult=await call('POST','/api/v1/query/',sample);
    assert(publicResult.records.every(row=>row.record_kind==='activity' && !Object.hasOwn(row,'id')));
    assert(publicResult.historical_balances.every(row=>!Object.hasOwn(row,'id') && !Object.hasOwn(row,'activity_name')));
    const all = (await db.query("SELECT * FROM volunteer_logs WHERE import_detail_status='cumulative_reconciliation'")).rows;
    assert.equal(all.length,1913);
    assert.equal((await db.query("SELECT count(*)::int c FROM volunteer_logs WHERE record_kind='historical_cumulative' AND activity_name IS NULL AND activity_id IS NULL")).rows[0].c,575);
    assert.equal((await db.query("SELECT count(*)::int c FROM activities WHERE name='累计时长记录'")).rows[0].c,0);
    assert(all.every(row => row.record_kind==='historical_balance' && row.activity_name===null && row.activity_id===null && row.activity_date===null));
    await assert.rejects(db.query('UPDATE volunteer_logs SET activity_name=$2 WHERE id=$1',[all[0].id,'Invented activity']),error=>error.code==='23514');
    await assert.rejects(db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,record_kind,activity_name,hours,source,status,import_batch_id,is_adjustment,adjustment_reason,import_detail_status,source_total_hours)
      SELECT student_id,student_name,college,grade,record_kind,activity_name,hours,source,status,import_batch_id,is_adjustment,adjustment_reason,import_detail_status,source_total_hours FROM volunteer_logs WHERE id=$1`,[all[0].id]),error=>error.code==='23505');
    for (const candidate of [all.find(row => Number(row.hours)>0),all.find(row => Number(row.hours)<0)]) {
      const result=await query.queryStudentLogs(candidate.student_id,candidate.student_name);
      const draft=await query.queryDraftStudentLogs(candidate.student_id,candidate.student_name);
      assert.equal(result.total_hours,Number(candidate.source_total_hours));
      assert.equal(draft.total_hours,result.total_hours);
      assert(result.records.every(row => row.record_kind==='activity'));
      const balance=result.historical_balances.find(row=>row.record_kind==='historical_balance');
      assert.equal(balance.source_total_hours,Number(candidate.source_total_hours));
      assert.equal(balance.hours,Number(candidate.hours));
      assert(!Object.hasOwn(balance,'activity_name'));
      assert(!Object.hasOwn(balance,'activity_code'));
      assert.equal(result.records.reduce((n,row)=>n+Math.round(row.hours*10),0)+result.historical_balances.reduce((n,row)=>n+Math.round(row.hours*10),0),Math.round(result.total_hours*10));
      const lookup=await call('POST','/api/v1/admin-search/',{mode:'student_id',value:candidate.student_id,other_value:candidate.student_name});
      assert(lookup.matches[0].historical_balances.some(row=>row.record_kind==='historical_balance'));
      await call('PATCH',`/api/v1/reviews/logs/${candidate.id}`,{activity_name:'Synthetic mistake',note:'Must not become an activity'},409);
      await call('DELETE',`/api/v1/logs/${candidate.id}`,{reason:'Must not void a transcript as an activity'},409);
    }
    const listed=await call('GET','/api/v1/logs?limit=1000');
    assert(listed.every(row=>row.record_kind==='activity'));
    const balances=await call('GET','/api/v1/logs?record_kind=historical_balance&limit=1000');
    assert(balances.length && balances.every(row=>row.record_kind==='historical_balance'&&row.activity_name===null));
    const ranking=await call('GET','/api/v1/stats/rankings');
    assert(ranking.activities.every(row=>row.activity_name && row.activity_name!=='最终累计成绩单校准'));
    // Historical frozen snapshots must remain exportable without leaking the former invented name.
    const old=(await publication.current()).batch;
    priorPublication=old.id;
    const oldHash=(await db.query('SELECT md5(snapshot::text) AS hash FROM publication_batches WHERE id=$1',[old.id])).rows[0].hash;
    const archive=await createArchive(old);
    const outer=await JSZip.loadAsync(archive.buffer);
    for(const entry of Object.values(outer.files).filter(file=>file.name.endsWith('.xlsx'))) {
      const book=await JSZip.loadAsync(await entry.async('nodebuffer'));
      for(const part of Object.values(book.files).filter(file=>!file.dir&&file.name.endsWith('.xml'))) {
        assert(!(await part.async('string')).includes('最终累计成绩单校准'),'Frozen export must not invent an activity');
      }
    }
    assert.equal(archive.studentCount,9462); assert.equal(Number(old.total_hours),355249.9);
    // A real subsequent activity is added to the accepted cumulative total, once.
    const suffix=crypto.randomUUID().slice(0,8), student='BALANCE-'+suffix;
    fixtureStudent=student;
    const batch=all[0].import_batch_id;
    await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,hours,source,status,import_batch_id)
      VALUES($1,'回归核对','计算机科学与工程学院','26级','真实历史活动',10,'imported','approved',$2)`,[student,batch]);
    await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,record_kind,activity_name,hours,source,status,import_batch_id,is_adjustment,adjustment_reason,import_detail_status,source_total_hours)
      VALUES($1,'回归核对','计算机科学与工程学院','26级','historical_balance',NULL,-4,'imported','approved',$2,true,'来自已核定成绩单','cumulative_reconciliation',6)`,[student,batch]);
    let draft=await query.queryDraftStudentLogs(student,'回归核对');
    assert.equal(draft.total_hours,6); assert.equal(draft.records.length,1); assert.equal(draft.historical_balances.length,1);
    const activity=await call('POST','/api/v1/activities/',{name:'真实后续活动 '+suffix,start_time:'2026-10-19T08:00:00+08:00',end_time:'2026-10-19T11:00:00+08:00',location:'回归验证',org_name:'回归验证'},201);
    fixtureActivity=activity.id;
    const submitted=await call('POST','/api/v1/logs/',{activity_id:activity.id,records:[{student_id:student,student_name:'回归核对',college:'计算机科学与工程学院',grade:'26级',hours:2.5}]},201);
    const log=(await db.query('SELECT id FROM volunteer_logs WHERE activity_id=$1',[activity.id])).rows[0];
    assert(log,JSON.stringify(submitted));
    await call('PATCH',`/api/v1/logs/${log.id}/approve`,{});
    await call('POST','/api/v1/logs/',{activity_id:activity.id,records:[{student_id:student,student_name:'回归核对',college:'计算机科学与工程学院',grade:'26级',hours:2.5}]},400);
    draft=await query.queryDraftStudentLogs(student,'回归核对'); assert.equal(draft.total_hours,8.5); assert.equal(draft.records.length,2);
    fixturePublication=(await publication.publish(admin.id,{publication_month:'2026-10',label:'隔离回归'})).batch.id;
    const published=await query.queryStudentLogs(student,'回归核对');
    assert.equal(published.total_hours,8.5); assert.equal(published.historical_balances[0].source_total_hours,6); assert.equal(published.records.length,2);
    assert.equal((await db.query('SELECT md5(snapshot::text) AS hash FROM publication_batches WHERE id=$1',[old.id])).rows[0].hash,oldHash);
    console.log('PASS historical balances are separate across public/draft/admin/list/rank/export; positive and negative adjustments preserve totals; old snapshots unchanged; subsequent real activity is approved and published exactly once');
  } finally {
    if(fixturePublication) {
      await db.query('UPDATE publication_state SET publication_id=$1 WHERE id=true',[priorPublication]);
      await db.query('DELETE FROM publication_batches WHERE id=$1',[fixturePublication]);
    }
    if(fixtureStudent) await db.query("DELETE FROM volunteer_logs WHERE student_id=$1 AND student_name='回归核对'",[fixtureStudent]);
    if(fixtureActivity) await db.query('DELETE FROM activities WHERE id=$1',[fixtureActivity]);
    await app.close(); await db.pool.end();
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
