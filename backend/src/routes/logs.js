const db = require('../db');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const publication = require('../services/publicationService');
const { reviewState } = require('../services/reviewState');
const {
  authenticate
} = require('../middlewares/auth');
const {
  requireCapability,
  hasCapability,
  hasFullAccess
} = require('../middlewares/rbac');
const {
  UUID
} = require('../services/sessionService');
const {
  validateParticipants,
  parseWorkbook
} = require('../services/participantService');
const {
  writeAudit
} = require('../services/auditService');
const {
  normalizeCollegeName
} = require('../utils/collegeNames');
const failure = (code, message) => Object.assign(new Error(message), {
  statusCode: code
});
async function hasEffectiveDuplicate(client, row) {
  // Imported histories with unknown dates cannot establish the same activity identity.
  const result = await client.query(`SELECT id FROM volunteer_logs
    WHERE id<>$1 AND status IN ('pending','approved','rejected')
      AND student_id=$2 AND is_adjustment=$3
      AND ($3=false OR (hours=$4 AND adjustment_reason=$5))
      AND (activity_id=$6::uuid OR (activity_date=$7::date AND activity_name=$8)) LIMIT 1`,
  [row.id, row.student_id, Boolean(row.is_adjustment), row.hours, row.adjustment_reason,
    row.source === 'online' ? row.activity_id : null, row.activity_date, row.activity_name]);
  return result.rowCount > 0;
}
async function lockedLog(client, id) {
  const hint = (await client.query('SELECT activity_id FROM volunteer_logs WHERE id=$1', [id])).rows[0];
  if (!hint) return null;
  if (hint.activity_id) await client.query('SELECT id FROM activities WHERE id=$1 FOR UPDATE', [hint.activity_id]);
  const row = (await client.query('SELECT * FROM volunteer_logs WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (row && row.activity_id !== hint.activity_id) throw failure(409, '记录的关联活动已变化，请刷新后重试');
  return row;
}
async function activityFor(client, request, id, lock = false) {
  if (!UUID.test(id || '')) throw failure(400, '活动编号无效');
  const activity = (await client.query(`SELECT *, (start_time AT TIME ZONE 'Asia/Shanghai')::date AS activity_date
    FROM activities WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  if (!activity || activity.deleted_at) throw failure(404, '活动不存在或已删除');
  if (activity.status !== 'active') throw failure(409, '活动已归档，请先恢复后再填报');
  if (!hasFullAccess(request.user) && activity.created_by !== request.user.id) throw failure(403, '只能提交自己负责活动的名单');
  if (!activity.activity_date) throw failure(400, '新申报需要真实日期，请创建带真实日期的活动');
  if (request.user.role === 'college_admin' && !request.user.org_name) throw failure(403, '账号未配置所属学院');
  return activity;
}
module.exports = async function (app) {
  app.addHook('preHandler', authenticate);
  app.get('/', async (request, reply) => {
    if (!hasCapability(request.user.role, 'logs:submit') && !hasCapability(request.user.role, 'logs:review')) return reply.code(403).send({
      message: '没有名单查看权限'
    });
    const params = [],
      filters = [];
    if (request.query.record_kind && !['activity', 'historical_balance','historical_cumulative'].includes(request.query.record_kind)) return reply.code(400).send({message:'记录类型无效'});
    params.push(request.query.record_kind || 'activity');
    filters.push(`record_kind=$${params.length}`);
    for (const field of ['status', 'source', 'activity_id', 'student_id']) if (request.query[field]) {
      params.push(request.query[field]);
      filters.push(`${field}=$${params.length}`);
    }
    if (request.query.include_inactive !== 'true' && !request.query.status) filters.push("status IN ('pending','approved','rejected')");
    if (request.query.legacy_unprocessed === 'true') filters.push(reviewState('volunteer_logs').open);
    if (request.user.role === 'college_admin') {
      if (!request.user.org_name) return reply.code(403).send({
        message: '账号未配置所属学院'
      });
      params.push(normalizeCollegeName(request.user.org_name));
      filters.push(`college=$${params.length}`);
    } else if (!hasFullAccess(request.user) && !hasCapability(request.user.role, 'logs:review')) {
      params.push(request.user.id);
      filters.push(`submitted_by=$${params.length}`);
    }
    const limit = Math.max(1, Math.min(Number(request.query.limit) || 200, 1000));
    params.push(limit);
    const stateSql = reviewState('volunteer_logs');
    const rows = (await db.query(`SELECT *, ${stateSql.processed} AS is_legacy_processed, ${stateSql.type} AS review_resolution FROM volunteer_logs WHERE ${filters.length ? filters.join(' AND ') : 'true'} ORDER BY created_at DESC,id LIMIT $${params.length}`, params)).rows;
    const state = await publication.current();
    return rows.map(row => ({
      ...row,
      publication_status: row.status === 'approved' ? publication.isPublished(state, row) ? 'published' : 'waiting' : null
    }));
  });
  app.get('/template', {
    preHandler: [requireCapability('logs:submit')]
  }, async (request, reply) => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet('活动名单');
    sheet.addRows([['学号', '姓名', '学院', '年级', '服务时长（小时）', '联系方式'], ['TEST-STUDENT-001', '测试学生', request.user.org_name || '计算机科学与工程学院', '26级', 2.5, '']]);
    sheet.columns.forEach(column => {
      column.width = 22;
    });
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="activity-participants.xlsx"').send(Buffer.from(await workbook.xlsx.writeBuffer()));
  });
  app.post('/preview-file', {
    preHandler: [requireCapability('logs:submit')]
  }, async (request, reply) => {
    try {
      const activity = await activityFor(db, request, request.query.activity_id);
      const file = await request.file();
      if (!file || !/\.xlsx$/i.test(file.filename || '')) throw failure(400, '请上传.xlsx格式的名单文件');
      const rows = await validateParticipants(db, request.user, activity, await parseWorkbook(await file.toBuffer()));
      return {
        rows,
        total: rows.length,
        errors: rows.filter(row => row.errors.length).length
      };
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    }
  });
  app.post('/preview', {
    preHandler: [requireCapability('logs:submit')]
  }, async (request, reply) => {
    try {
      const activity = await activityFor(db, request, request.body?.activity_id);
      const rows = await validateParticipants(db, request.user, activity, request.body?.records);
      return {
        rows,
        total: rows.length,
        errors: rows.filter(row => row.errors.length).length
      };
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    }
  });
  app.post('/', {
    preHandler: [requireCapability('logs:submit')]
  }, async (request, reply) => {
    const client = await db.pool.connect();
    let count,
      already_submitted = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(927641)');
      const body = request.body || {},
        activity = await activityFor(client, request, body.activity_id, true);
      const submissionKey = body.submission_key || crypto.randomUUID();
      if (!UUID.test(submissionKey)) throw failure(400, '提交编号无效，请重新预览');
      const hash = crypto.createHash('sha256').update(JSON.stringify([activity.id, request.user.id, body.records])).digest('hex');
      const existing = (await client.query('SELECT submitted_by,activity_id,submission_hash FROM volunteer_logs WHERE submission_key=$1', [submissionKey])).rows;
      if (existing.length) {
        if (existing.some(row => row.submitted_by !== request.user.id || row.activity_id !== activity.id || row.submission_hash !== hash)) throw failure(409, '同一提交编号的数据发生变化，请重新预览');
        count = existing.length;
        already_submitted = true;
      } else {
        const rows = await validateParticipants(client, request.user, activity, body.records);
        const invalid = rows.find(row => row.errors.length);
        if (invalid) throw failure(invalid.errors.includes('只能提交本学院学生') ? 403 : 400, `第${invalid.row}行：${invalid.errors.join('；')}`);
        for (const row of rows) {
          const grade = row.grade || (await client.query("SELECT grade FROM volunteer_logs WHERE student_id=$1 AND student_name=$2 AND college=$3 AND grade IS NOT NULL AND grade<>'' ORDER BY created_at DESC LIMIT 1", [row.student_id, row.student_name, row.college])).rows[0]?.grade || null;
          await client.query(`INSERT INTO volunteer_logs(student_id,student_name,college,grade,hours,phone,activity_id,activity_name,activity_date,
            source,status,submitted_by,academic_year,academic_term,submission_key,submission_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'online','pending',$10,$11,$12,$13,$14)`, [row.student_id, row.student_name, row.college, grade, row.hours, row.phone || null, activity.id, activity.name, activity.activity_date, request.user.id, activity.academic_year, activity.academic_term, submissionKey, hash]);
        }
        count = rows.length;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    } finally {
      client.release();
    }
    if (!already_submitted) await writeAudit(request, 'logs.submit', 'activity', request.body.activity_id, {
      count
    });
    return reply.code(already_submitted ? 200 : 201).send({
      count,
      already_submitted,
      message: `${count}条记录已提交，等待审核`
    });
  });
  async function lifecycle(request, reply, restore = false) {
    const id = request.params.id,
      reason = String(request.body?.reason || '').trim();
    if (!UUID.test(id || '')) return reply.code(400).send({
      message: '记录编号无效'
    });
    if (!reason || reason.length > 512) return reply.code(400).send({
      message: '请填写不超过512字的操作原因'
    });
    const client = await db.pool.connect();
    let updated;
    try {
      await client.query('BEGIN');
      // Serialize restore checks and updates with imports before taking activity or record locks.
      if (restore) await client.query('SELECT pg_advisory_xact_lock(927641)');
      const before = await lockedLog(client, id);
      if (!before) throw failure(404, '记录不存在');
      const canReview = hasCapability(request.user.role, 'logs:review');
      const owns = hasCapability(request.user.role, 'logs:submit') && before.submitted_by === request.user.id;
      if (request.user.role === 'college_admin' && before.college !== normalizeCollegeName(request.user.org_name)) throw failure(403, '只能处理所属学院记录');
      if (!canReview && !owns) throw failure(403, '没有该记录的操作权限');
      if (['historical_balance','historical_cumulative'].includes(before.record_kind)) throw failure(409, '历史累计记录不能按活动撤回、作废或恢复');
      if (restore) {
        if (!['withdrawn', 'voided'].includes(before.status)) throw failure(409, '记录未撤回或作废');
        if (before.status === 'voided' && !canReview) throw failure(403, '只有审核管理人员可以恢复已作废记录');
        if (before.activity_id) {
          const activity = (await client.query('SELECT status,deleted_at FROM activities WHERE id=$1 FOR UPDATE', [before.activity_id])).rows[0];
          if (!activity || activity.deleted_at || activity.status !== 'active') throw failure(409, '关联活动已删除或归档，请先恢复活动');
        }
        if (await hasEffectiveDuplicate(client, before)) throw failure(409, '存在有效重复记录，不能恢复');
        if (before.import_batch_id) {
          const batch = (await client.query('SELECT superseded_at FROM import_batches WHERE id=$1', [before.import_batch_id])).rows[0];
          if (batch?.superseded_at) throw failure(409, '该记录属于已替换的时长库旧版本，请通过更新时长库更正');
        }
        const status = before.lifecycle_previous_status || 'pending';
        updated = (await client.query('UPDATE volunteer_logs SET status=$2::log_status,lifecycle_reason=$3,lifecycle_at=now(),lifecycle_by=$4 WHERE id=$1 RETURNING *', [id, status, reason, request.user.id])).rows[0];
      } else {
        if (!['pending', 'approved', 'rejected'].includes(before.status)) throw failure(409, '记录已撤回或作废');
        if (before.status === 'approved' && !canReview) throw failure(403, '审核通过的记录须由审核管理人员作废');
        updated = (await client.query(`UPDATE volunteer_logs SET lifecycle_previous_status=status::text,status=$2::log_status,
          lifecycle_reason=$3,lifecycle_at=now(),lifecycle_by=$4 WHERE id=$1 RETURNING *`, [id, before.status === 'approved' ? 'voided' : 'withdrawn', reason, request.user.id])).rows[0];
      }
      await client.query('INSERT INTO review_notes(log_id,user_id,username,action,detail) VALUES($1,$2,$3,$4,$5)', [id, request.user.id, request.user.username, restore ? 'restore' : updated.status, {
        reason,
        before_status: before.status,
        after_status: updated.status,
        hours: before.hours
      }]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    } finally {
      client.release();
    }
    await writeAudit(request, restore ? 'logs.restore' : `logs.${updated.status}`, 'volunteer_log', id, {
      reason
    });
    return updated;
  }
  app.delete('/:id', (request, reply) => lifecycle(request, reply));
  app.post('/:id/restore', (request, reply) => lifecycle(request, reply, true));
  app.patch('/:id/resubmit', {
    preHandler: [requireCapability('logs:submit')]
  }, async (request, reply) => {
    const client = await db.pool.connect();
    let updated;
    try {
      if (!UUID.test(request.params.id || '')) throw failure(400, '记录编号无效');
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(927641)');
      const before = await lockedLog(client, request.params.id);
      if (!before) throw failure(404, '记录不存在');
      if (before.submitted_by !== request.user.id && !hasFullAccess(request.user)) throw failure(403, '只能重新提交自己的记录');
      if (!['rejected', 'withdrawn'].includes(before.status)) throw failure(409, '只有被驳回或撤回的记录可修正重提');
      const activity = await activityFor(client, request, before.activity_id, true);
      const rows = await validateParticipants(client, request.user, activity, [{
        ...before,
        ...request.body,
        activity_id: before.activity_id
      }]);
      const row = rows[0];
      // A rejected record is the row being replaced, not a second participant.
      row.errors = row.errors.filter(error => !error.startsWith('同一活动'));
      if (await hasEffectiveDuplicate(client, { ...before, ...row })) row.errors.push('同一活动已有该学生的有效记录');
      if (row.errors.length) throw failure(400, row.errors.join('；'));
      updated = (await client.query(`UPDATE volunteer_logs SET student_id=$2,student_name=$3,college=$4,grade=$5,hours=$6,phone=$7,
        status='pending',reject_reason=NULL,reviewed_by=NULL,reviewed_at=NULL,lifecycle_previous_status=NULL,
        lifecycle_reason=NULL,lifecycle_at=NULL,lifecycle_by=NULL WHERE id=$1 RETURNING *`, [before.id, row.student_id, row.student_name, row.college, row.grade || null, row.hours, row.phone || null])).rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    } finally {
      client.release();
    }
    await writeAudit(request, 'logs.resubmit', 'volunteer_log', updated.id, {
      hours: updated.hours
    });
    return updated;
  });
  const reviewer = {
    preHandler: [requireCapability('logs:review')]
  };
  app.patch('/:id/approve', reviewer, async (request, reply) => {
    if (!UUID.test(request.params.id || '')) return reply.code(400).send({
      message: '记录编号无效'
    });
    const row = (await db.query("UPDATE volunteer_logs SET status='approved',reject_reason=NULL,reviewed_by=$2,reviewed_at=now() WHERE id=$1 AND status='pending' RETURNING *", [request.params.id, request.user.id])).rows[0];
    if (!row) return reply.code(409).send({
      message: '记录已处理，不能重复审核'
    });
    await writeAudit(request, 'logs.approve', 'volunteer_log', row.id);
    return row;
  });
  app.post('/batch-approve', reviewer, async (request, reply) => {
    const ids = request.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => !UUID.test(id))) return reply.code(400).send({
      message: '请选择有效的待审记录'
    });
    const rows = (await db.query("UPDATE volunteer_logs SET status='approved',reject_reason=NULL,reviewed_by=$2,reviewed_at=now() WHERE id=ANY($1::uuid[]) AND status='pending' RETURNING id", [ids, request.user.id])).rows;
    await writeAudit(request, 'logs.batch_approve', null, null, {
      ids,
      count: rows.length
    });
    return {
      count: rows.length
    };
  });
  app.patch('/:id/reject', reviewer, async (request, reply) => {
    const reason = String(request.body?.reason || '').trim();
    if (!UUID.test(request.params.id || '') || !reason || reason.length > 512) return reply.code(400).send({
      message: '请填写有效编号和不超过512字的驳回原因'
    });
    const row = (await db.query("UPDATE volunteer_logs SET status='rejected',reject_reason=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1 AND status='pending' RETURNING *", [request.params.id, reason, request.user.id])).rows[0];
    if (!row) return reply.code(409).send({
      message: '记录已处理，不能重复驳回'
    });
    await writeAudit(request, 'logs.reject', 'volunteer_log', row.id, {
      reason
    });
    return row;
  });
  app.patch('/:id/mark-processed', reviewer, async (request, reply) => {
    if (!UUID.test(request.params.id || '')) return reply.code(400).send({
      message: '记录编号无效'
    });
    const row = (await db.query("UPDATE volunteer_logs SET is_legacy_processed=true WHERE id=$1 AND source='imported' AND status IN ('pending','approved','rejected') RETURNING *", [request.params.id])).rows[0];
    if (!row) return reply.code(404).send({
      message: '有效导入记录不存在'
    });
    await writeAudit(request, 'logs.mark_processed', 'volunteer_log', row.id);
    return row;
  });
};
