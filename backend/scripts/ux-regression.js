const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const url=new URL(process.env.UX_TEST_DATABASE_URL||'invalid:');
assert.equal(url.pathname,'/ux_test');assert(['localhost','127.0.0.1'].includes(url.hostname));
process.env.DATABASE_URL=url.href;
const bcrypt=require('bcrypt');
const ExcelJS=require('exceljs');
const db=require('../src/db');
const {ensureSchema}=require('../src/db/ensureSchema');
const {buildApp}=require('../src/app');
const publication=require('../src/services/publicationService');
const query=require('../src/services/queryService');
const college='计算机科学与工程学院',otherCollege='数学科学学院';
const accounts={},checks=[];
const app=buildApp();
function check(name){checks.push(name);console.log('PASS '+name);}
const call=(user,method,path,payload)=>app.inject({method,url:'/api/v1'+path,payload,headers:user?{authorization:'Bearer '+accounts[user].access_token}:{}});
async function expect(user,method,path,payload,code=200){const result=await call(user,method,path,payload);assert.equal(result.statusCode,code,result.body);return result.json();}
async function login(role){
  const result=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'ux-'+role,password:process.env.UX_TEST_PASSWORD}});
  assert.equal(result.statusCode,200,result.body);accounts[role]={...accounts[role],...result.json()};return result.json();
}
async function previewFile(buffer,user='data_admin'){
  const boundary='ux-'+crypto.randomUUID();
  const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const response=await app.inject({method:'POST',url:'/api/v1/import/preview',payload,headers:{authorization:'Bearer '+accounts[user].access_token,'content-type':'multipart/form-data; boundary='+boundary}});
  assert.equal(response.statusCode,200,response.body);return response.json();
}
async function main(){
  await ensureSchema();
  await db.query('TRUNCATE review_notes,operation_logs,publication_state,publication_batches,volunteer_logs,import_batches,activities,users RESTART IDENTITY CASCADE');
  const hash=await bcrypt.hash(process.env.UX_TEST_PASSWORD,12);
  for(const role of ['super_admin','admin','data_admin','college_admin','auditor','organizer']){
    const row=(await db.query('INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING id',
      ['ux-'+role,hash,'体验测试-'+role,role,college])).rows[0];accounts[role]={id:row.id};
  }
  await app.ready();
  for(const role of Object.keys(accounts)){
    await login(role);const me=await expect(role,'GET','/auth/me');assert.equal(me.user.role,role);assert(Array.isArray(me.user.capabilities));
  }
  check('six real accounts resolve capabilities from database');
  await expect('organizer','GET','/users',undefined,403);
  await expect('data_admin','GET','/activities',undefined,403);
  await expect('auditor','POST','/activities',{name:'禁止'},403);
  await expect('college_admin','GET','/stats/overview',undefined,403);
  await expect('college_admin','POST','/publications',{publication_month:'2026-10',label:'禁止'},403);
  const refreshAsAccess=await app.inject({method:'GET',url:'/api/v1/auth/me',headers:{authorization:'Bearer '+accounts.organizer.refresh_token}});
  assert.equal(refreshAsAccess.statusCode,401);
  check('hidden actions remain forbidden and refresh token is not an access token');
  const old={...accounts.organizer};
  await expect('admin','PATCH','/users/'+old.id+'/toggle-active',{});
  assert.equal((await call('organizer','GET','/auth/me')).statusCode,401);
  const staleRefresh=await app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refresh_token:old.refresh_token}});assert.equal(staleRefresh.statusCode,401);
  await expect('admin','PATCH','/users/'+old.id+'/toggle-active',{});await login('organizer');
  await expect('admin','DELETE','/users/'+accounts.admin.id,undefined,409);
  await expect('admin','PATCH','/users/'+accounts.organizer.id,{real_name:'组织者',role:'auditor',org_name:college});
  assert.equal((await call('organizer','GET','/auth/me')).statusCode,401);await login('organizer');
  await expect('organizer','POST','/activities',{name:'禁止'},403);
  await expect('admin','PATCH','/users/'+accounts.organizer.id,{real_name:'组织者',role:'organizer',org_name:college});await login('organizer');
  check('disable and role changes invalidate old sessions immediately');
  await expect('admin','PATCH','/users/'+accounts.admin.id,{real_name:'测试管理员姓名更新',role:'admin',org_name:college});
  assert.equal((await expect('admin','GET','/auth/me')).user.real_name,'测试管理员姓名更新');
  check('ordinary profile edits preserve the active session');

  const input={name:'校园志愿活动',start_time:'2026-10-13T09:00:00+08:00',end_time:'2026-10-13T12:00:00+08:00',org_name:college};
  const empty=await expect('college_admin','POST','/activities',{...input,name:'空活动'},201);
  await expect('college_admin','DELETE','/activities/'+empty.id);
  assert(!(await expect('college_admin','GET','/activities')).some(row=>row.id===empty.id));
  await expect('college_admin','POST','/activities/'+empty.id+'/restore',{});
  const activity=await expect('college_admin','POST','/activities',input,201);
  await expect('organizer','GET','/activities/'+activity.id,undefined,403);
  const record={student_id:'UX-001',student_name:'测试学生',college,grade:'26级',hours:2.5};
  const bad=await expect('college_admin','POST','/logs/preview',{activity_id:activity.id,records:[{...record,college:otherCollege}]});assert(bad.rows[0].errors.length);
  const preview=await expect('college_admin','POST','/logs/preview',{activity_id:activity.id,records:[record]});assert.equal(preview.errors,0);
  const payload={activity_id:activity.id,records:[record],submission_key:crypto.randomUUID()};
  const parallel=await Promise.all([call('college_admin','POST','/logs',payload),call('college_admin','POST','/logs',payload)]);
  assert.deepEqual(parallel.map(result=>result.statusCode).sort(),[200,201]);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM volunteer_logs WHERE activity_id=$1',[activity.id])).rows[0].count,1);
  await expect('college_admin','POST','/logs',{...payload,records:[{...record,hours:3}]},409);
  await expect('college_admin','DELETE','/activities/'+activity.id,undefined,409);
  check('empty activity deletion and ownership; concurrent submission is idempotent');
  const log=(await expect('college_admin','GET','/logs?activity_id='+activity.id))[0];
  await expect('data_admin','PATCH','/logs/'+log.id+'/reject',{reason:'时长需要核对'});
  await expect('college_admin','PATCH','/logs/'+log.id+'/resubmit',{hours:2});
  await expect('data_admin','PATCH','/logs/'+log.id+'/approve',{});
  await expect('college_admin','DELETE','/logs/'+log.id,{reason:'误报'},403);
  await expect('admin','POST','/publications',{publication_month:'2026-10',label:'体验验证公示'});
  assert.equal((await query.queryStudentLogs(record.student_id,record.student_name)).total_hours,2);
  await expect('data_admin','DELETE','/logs/'+log.id,{reason:'重复申报，作废'});
  assert.equal((await query.queryStudentLogs(record.student_id,record.student_name)).total_hours,2);
  assert.equal((await query.queryStudentLogs(record.student_id,record.student_name)).review_progress[0].status,'voided');
  await expect('admin','POST','/publications',{publication_month:'2026-10',label:'更正公示'});
  assert.equal((await query.queryStudentLogs(record.student_id,record.student_name)).total_hours,0);
  await expect('data_admin','POST','/logs/'+log.id+'/restore',{reason:'核实恢复'});
  const detail=await expect('college_admin','GET','/activities/'+activity.id);assert.equal(detail.counts.waiting_publication,1);
  check('rejected corrections; void changes draft totals only until next publication; audited restore');
  const adjustment=(await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status,is_adjustment,adjustment_reason)
    VALUES($1,$2,$3,'26级',$4,'2026-10-13',-0.5,'imported','approved',true,'隔离测试扣减') RETURNING id`,[record.student_id,record.student_name,college,activity.name])).rows[0].id;
  await expect('data_admin','DELETE','/logs/'+adjustment,{reason:'核对扣减'});
  await expect('data_admin','POST','/logs/'+adjustment+'/restore',{reason:'核实恢复原扣减'});
  const historical=(await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status,source_file)
    VALUES('UX-LEGACY','历史累计样例',$1,'26级','历史累计记录',NULL,2,'imported','approved','legacy-fixture-A.xlsx'),
    ('UX-LEGACY','历史累计样例',$1,'26级','历史累计记录',NULL,2,'imported','approved','legacy-fixture-B.xlsx') RETURNING id`,[college])).rows[0].id;
  await expect('data_admin','DELETE','/logs/'+historical,{reason:'核对不同历史来源'});
  await expect('data_admin','POST','/logs/'+historical+'/restore',{reason:'确认两个不同来源均有效'});
  assert.equal((await query.queryDraftStudentLogs('UX-LEGACY','历史累计样例')).total_hours,4);
  check('adjustment restore distinguishes normal hours; unknown-date source histories stay distinct');

  const workbook=async hours=>{const book=new ExcelJS.Workbook();book.addWorksheet('26级').addRows([
    ['学号','姓名','学院','年级','活动名称','活动日期','累计服务时长'],['UX-IMPORT','导入样例',college,'26级','办公室时长库','2026-10-13',hours]]);return Buffer.from(await book.xlsx.writeBuffer());};
  const firstPreview=await previewFile(await workbook(3));
  const rowKeys=firstPreview.rows.map(row=>`${row.sheet||''}:${row.row||''}:${row.student_id||''}:${row.student_name||''}`);
  const options={preview_id:firstPreview.preview_id,dataset_key:'ux-fixture-dataset',note:'十月时长库',confirmed_row_keys:rowKeys,skipped_row_keys:[],replace_dataset:false};
  const receipt=await expect('data_admin','POST','/import/prepare',options);assert.equal(receipt.new_count,1);assert.equal(receipt.new_hours,3);
  await expect('admin','POST','/import/confirm',{preview_id:firstPreview.preview_id,confirmation_id:receipt.confirmation_id},400);
  const imported=await expect('data_admin','POST','/import/confirm',{preview_id:firstPreview.preview_id,confirmation_id:receipt.confirmation_id});assert.equal(imported.count,1);
  const replay=await expect('data_admin','POST','/import/confirm',{preview_id:firstPreview.preview_id,confirmation_id:receipt.confirmation_id});assert.equal(replay.batch_id,imported.batch_id);
  const secondPreview=await previewFile(await workbook(4));
  const keys=secondPreview.rows.map(row=>`${row.sheet||''}:${row.row||''}:${row.student_id||''}:${row.student_name||''}`);
  const second=await expect('data_admin','POST','/import/prepare',{...options,preview_id:secondPreview.preview_id,replace_dataset:true,confirmed_row_keys:keys});
  assert.equal(second.delta_hours,1);
  await expect('data_admin','POST','/import/confirm',{preview_id:secondPreview.preview_id,confirmation_id:second.confirmation_id});
  const versions=(await db.query("SELECT status,hours FROM volunteer_logs WHERE student_id='UX-IMPORT' ORDER BY created_at")).rows;
  assert.deepEqual(versions.map(row=>row.status),['voided','approved']);assert.equal(Number(versions[1].hours),4);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM import_batches WHERE dataset_key='ux-fixture-dataset'")).rows[0].count,2);
  const sameFile=await previewFile(await workbook(4));
  const sameReceipt=await expect('data_admin','POST','/import/prepare',{...options,preview_id:sameFile.preview_id,replace_dataset:true,
    default_academic_year:'2025-2026',confirmed_row_keys:sameFile.rows.map(row=>`${row.sheet}:${row.row}:${row.student_id}:${row.student_name}`)});
  const changedDefaults=await expect('data_admin','POST','/import/confirm',{preview_id:sameFile.preview_id,confirmation_id:sameReceipt.confirmation_id});
  assert.equal(changedDefaults.count,1);
  assert.equal((await db.query("SELECT academic_year FROM volunteer_logs WHERE student_id='UX-IMPORT' AND status='approved'")).rows[0].academic_year,'2025-2026');
  check('same-file dataset update applies changed defaults without being mistaken for a replay');
  const stalePreview=await previewFile(await workbook(5));
  const stale=await expect('data_admin','POST','/import/prepare',{...options,preview_id:stalePreview.preview_id,replace_dataset:true,confirmed_row_keys:stalePreview.rows.map(row=>`${row.sheet}:${row.row}:${row.student_id}:${row.student_name}`)});
  await db.query('UPDATE volunteer_logs SET hours=hours+0.1 WHERE id=$1',[log.id]);
  await expect('data_admin','POST','/import/confirm',{preview_id:stalePreview.preview_id,confirmation_id:stale.confirmation_id},400);
  check('dataset replacement retains history; receipt owns user and revision; retries do not duplicate');
  await expect('admin','DELETE','/users/'+accounts.college_admin.id);
  assert.equal((await call('college_admin','GET','/auth/me')).statusCode,401);
  assert((await db.query('SELECT id FROM activities WHERE created_by=$1',[accounts.college_admin.id])).rows.length);
  await expect('admin','POST','/users/'+accounts.college_admin.id+'/restore',{});
  assert.equal((await db.query('SELECT is_active FROM users WHERE id=$1',[accounts.college_admin.id])).rows[0].is_active,false);
  await expect('admin','PATCH','/users/'+accounts.college_admin.id+'/toggle-active',{});
  // Test the last-manager rule even when the caller's role was changed concurrently.
  await db.query("UPDATE users SET is_active=false WHERE role='super_admin'");
  await expect('admin','PATCH','/users/'+accounts.admin.id+'/toggle-active',{},409);
  await db.query("UPDATE users SET is_active=true WHERE role='super_admin'");
  check('account soft deletion preserves attribution and safe restore');
  const competing=await Promise.all([call('admin','DELETE','/users/'+accounts.super_admin.id),call('super_admin','DELETE','/users/'+accounts.admin.id)]);
  assert.deepEqual(competing.map(result=>result.statusCode).sort(),[200,409]);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM users WHERE is_active AND deleted_at IS NULL AND role IN ('admin','super_admin')")).rows[0].count,1);
  check('concurrent manager deletion leaves a usable manager');
  const cache=require('../src/cache/redis');
  process.env.REDIS_URL='redis://127.0.0.1:1';
  const started=Date.now();let timeout;
  const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('optional cache failure must not block import completion')),2500);});
  try {assert.equal(await Promise.race([cache.deleteByPrefix('query:'),deadline]),0);assert(Date.now()-started<2500);}
  finally {clearTimeout(timeout);await cache.close();delete process.env.REDIS_URL;}
  check('offline optional cache settles within a bounded timeout');


  assert((await db.query("SELECT id FROM review_notes WHERE log_id=$1",[log.id])).rows.length>=2);
  console.log(JSON.stringify({ux_integration:'passed',groups:checks.length,checks}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await app.close();await require('../src/cache/redis').close();await db.pool.end();});
