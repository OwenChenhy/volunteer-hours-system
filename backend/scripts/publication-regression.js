const assert = require('assert');
const crypto = require('crypto');
const testUrl = process.env.PUBLICATION_TEST_DATABASE_URL;
assert(testUrl && new URL(testUrl).pathname === '/publication_test' && ['127.0.0.1', 'localhost'].includes(new URL(testUrl).hostname), 'must use the dedicated server-local publication_test database');
process.env.DATABASE_URL = testUrl;
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
const db = require('../src/db');
const publication = require('../src/services/publicationService');
const academic = require('../src/services/academicService');
const query = require('../src/services/queryService');
const { buildApp } = require('../src/app');
const jwt = require('jsonwebtoken');
const admin = '00000000-0000-0000-0000-000000000011';
const college = '计算机科学与工程学院';
const app = buildApp();
const fixtures=new Map();
const inject = async (method,url,payload,role) => {
  if(!role) return app.inject({method,url,payload});
  if(!fixtures.has(role)) {
    const id=crypto.randomUUID();
    await db.query('INSERT INTO users(id,username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5,$6)',[id,'publication-role-'+id,'not-a-login-credential','测试角色',role,college]);
    fixtures.set(role,id);
  }
  const token=jwt.sign({id:fixtures.get(role),session_version:0,token_type:'access'},process.env.JWT_SECRET);
  return app.inject({method,url,payload,headers:{authorization:'Bearer '+token}});
};

async function main() {
  await db.query("INSERT INTO users(id,username,password_hash,real_name,role,org_name) VALUES($1,'publication-fixture','not-a-login-credential','测试管理员','admin',$2)", [admin,college]);
  await db.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status) VALUES
    ('PUB-001','同名样例',$1,'25级','已有公示活动','2026-04-01',8,'online','approved'),
    ('PUB-002','同名样例',$1,'25级','同分活动','2026-04-01',8,'online','approved'),
    ('PUB-003','第三样例',$1,'25级','第三活动','2026-04-01',5,'online','approved')`, [college]);
  await app.ready();
  const first = await publication.current();
  const options = { academic_year:'2025-2026', college, grade:'25级', limit:2 };
  assert.deepStrictEqual(publication.summary(first, options), await academic.getSummary(options));
  assert.strictEqual(publication.summary(first, {...options,page:2}).rows[0].rank,2);
  assert.strictEqual(publication.summary(first, {...options,page:8}).total_students,3);
  assert.strictEqual((await query.queryStudentLogs('PUB-001','同名样例')).review_progress.length,0);
  const pending = (await db.query("INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status) VALUES('PUB-001','同名样例',$1,'25级','本月待审活动','2026-10-01',2,'online','pending') RETURNING id",[college])).rows[0].id;
  const newcomerName = '首次提交样例';
  const newcomer = (await db.query("INSERT INTO volunteer_logs(student_id,student_name,college,grade,activity_name,activity_date,hours,source,status) VALUES('PUB-NEW',$1,$2,'26级','首次活动','2026-10-01',1,'online','pending') RETURNING id",[newcomerName,college])).rows[0].id;
  const before = await query.queryStudentLogs('PUB-001','同名样例');
  assert.strictEqual(before.total_hours,8); assert.strictEqual(before.review_progress[0].status,'pending');
  const onlyPending = await inject('POST','/api/v1/query',{student_id:'PUB-NEW',student_name:newcomerName});
  assert.strictEqual(onlyPending.statusCode,200); assert.strictEqual(onlyPending.json().total_hours,0); assert.strictEqual(onlyPending.json().records.length,0);
  const input = { publication_month:'2026-10', label:'十月统一公示' };
  assert.strictEqual((await inject('POST','/api/v1/publications',input,'college_admin')).statusCode,403);
  assert.strictEqual((await inject('POST','/api/v1/publications',input,'data_admin')).statusCode,403);
  assert.strictEqual((await inject('PATCH',`/api/v1/logs/${pending}/approve`,{},'college_admin')).statusCode,403);
  assert.strictEqual((await inject('POST','/api/v1/publications',input,'admin')).statusCode,409);
  await db.query("UPDATE volunteer_logs SET status='approved' WHERE id=$1",[pending]);
  await db.query("UPDATE volunteer_logs SET status='rejected', reject_reason='未核实完成' WHERE id=$1",[newcomer]);
  const approved = await query.queryStudentLogs('PUB-001','同名样例');
  assert.strictEqual(approved.total_hours,8); assert.strictEqual(approved.review_progress[0].status_label,'审核通过，待统一发布');
  assert.strictEqual((await query.getDataVersion()).publication_id,first.batch.id);
  const published = await inject('POST','/api/v1/publications',input,'admin');
  assert.strictEqual(published.statusCode,200);
  const next = await query.queryStudentLogs('PUB-001','同名样例');
  assert.strictEqual(next.total_hours,10); assert.strictEqual(next.review_progress.length,0);
  assert.strictEqual(next.academic_summaries.find(row=>row.academic_year==='2026-2027').upper_hours,2);
  assert.notStrictEqual(next.data_version.publication_id,first.batch.id);
  const repeat = await inject('POST','/api/v1/publications',input,'admin');
  assert.strictEqual(repeat.json().publication_id,published.json().publication_id);
  const stale = await inject('POST','/api/v1/query/summary',{student_id:'PUB-001',student_name:'同名样例',academic_year:'2025-2026',publication_id:first.batch.id});
  assert.strictEqual(stale.statusCode,409);
  const publicTable = await inject('POST','/api/v1/query/summary',{student_id:'PUB-001',student_name:'同名样例',academic_year:'2025-2026'});
  assert.strictEqual(publicTable.statusCode,200);
  assert(publicTable.json().rows.filter(row=>!row.is_self).every(row=>!row.student_id.includes('PUB')));
  const own = await inject('POST','/api/v1/query',{student_id:'PUB-001',student_name:'同名样例'});
  assert(own.json().records.every(row=>!('id' in row))); assert(own.json().review_progress.every(row=>!('id' in row) && !('student_id' in row)));
  const latest = await publication.current();
  const currentSql = await academic.getSummary(options);
  assert.deepStrictEqual(publication.summary(latest,options),currentSql);
  await db.query("UPDATE volunteer_logs SET hours=3 WHERE student_id='PUB-001' AND activity_name='本月待审活动'");
  assert.strictEqual((await query.queryStudentLogs('PUB-001','同名样例')).total_hours,10);
  assert.strictEqual((await query.queryDraftStudentLogs('PUB-001','同名样例')).total_hours,11);
  await new Promise(resolve=>setTimeout(resolve,1050));
  const originalQuery = db.query;
  let releaseRead, markRead;
  const blocked = new Promise(resolve=>{ releaseRead=resolve; });
  const started = new Promise(resolve=>{ markRead=resolve; });
  db.query = async (sql,params) => {
    const result = await originalQuery(sql,params);
    if (sql === 'SELECT publication_id FROM publication_state WHERE id = true') { markRead(); await blocked; }
    return result;
  };
  try {
    const read = publication.current(); await started;
    const switched = await publication.publish(admin,{...input,label:'统一更正公示'});
    releaseRead();
    assert.strictEqual((await read).batch.id,switched.batch.id,'a delayed reader must not overwrite the newly published snapshot');
  } finally { releaseRead(); db.query=originalQuery; }
  const start = Date.now();
  for(let n=0;n<2000;n++) publication.summary(latest,options);
  console.log(JSON.stringify({publication_isolation:'passed',pending_only_student:'passed',approved_waits_for_publication:'passed',pending_blocks_publication:'passed',roles_and_masking:'passed',idempotency:'passed',rank_and_pagination_match_sql:'passed',draft_correction_does_not_change_publication:'passed',cached_summaries:2000,cached_summary_total_ms:Date.now()-start}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await app.close();await db.pool.end();});
