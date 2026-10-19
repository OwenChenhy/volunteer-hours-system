const db = require('../db');
const academic = require('../services/academicService');
const publication = require('../services/publicationService');
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
  writeAudit
} = require('../services/auditService');
const {
  normalizeCollegeName
} = require('../utils/collegeNames');
const failure = (code, message) => Object.assign(new Error(message), {
  statusCode: code
});
async function find(client, request, lock = false) {
  if (!UUID.test(request.params.id || '')) throw failure(400, '活动编号无效');
  const activity = (await client.query(`SELECT a.*, (a.start_time AT TIME ZONE 'Asia/Shanghai')::date AS activity_date
    FROM activities a WHERE a.id=$1 ${lock ? 'FOR UPDATE' : ''}`, [request.params.id])).rows[0];
  if (!activity) throw failure(404, '活动不存在');
  if (!hasFullAccess(request.user) && activity.created_by !== request.user.id) throw failure(403, '只能管理自己负责的活动');
  return activity;
}
function data(body, user, before) {
  const name = String(body.name || '').trim();
  const {
    start_time,
    end_time
  } = body;
  if (!name || name.length > 256) throw failure(400, '请填写不超过256字的活动名称');
  const validTime = value => typeof value === 'string' && academic.validDate(value.slice(0, 10)) && /T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value));
  const historical = before && before.start_time === null && before.end_time === null && start_time === null && end_time === null;
  if (!historical && (!start_time || !end_time || !validTime(start_time) || !validTime(end_time) || Date.parse(end_time) < Date.parse(start_time))) throw failure(400, '请填写真实的起止时间，结束时间不能早于开始时间');
  if (body.academic_year && !academic.validYear(body.academic_year)) throw failure(400, '学年须为连续两年，如2026-2027');
  if (body.academic_term && !Object.hasOwn(academic.TERM_LABELS, body.academic_term)) throw failure(400, '归属阶段无效');
  const org = user.role === 'college_admin' ? user.org_name : body.org_name;
  if (user.role === 'college_admin' && !org) throw failure(403, '账号未配置所属学院');
  return [name, start_time, end_time, String(body.location || '').trim().slice(0, 128), normalizeCollegeName(org) || null, String(body.description || '').trim().slice(0, 4000), body.academic_year || null, body.academic_term || null];
}
function classified(row) {
  return {
    ...row,
    ...academic.classify(row),
    activity_time_label: row.start_time ? row.activity_date : '未注明具体日期',
    academic_year_inferred: !row.academic_year,
    academic_term_inferred: !row.academic_term
  };
}
module.exports = async function (app) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireCapability('activities:write'));
  app.get('/', async request => {
    const params = [],
      filter = [request.query.include_deleted === 'true' ? 'true' : 'a.deleted_at IS NULL'];
    if (!hasFullAccess(request.user)) {
      params.push(request.user.id);
      filter.push('a.created_by=$1');
    }
    const rows = (await db.query(`SELECT a.*, (a.start_time AT TIME ZONE 'Asia/Shanghai')::date AS activity_date,
      COALESCE(c.record_count,0)::int AS record_count,COALESCE(c.pending_count,0)::int AS pending_count,
      COALESCE(c.approved_count,0)::int AS approved_count,COALESCE(c.rejected_count,0)::int AS rejected_count
      FROM activities a LEFT JOIN (SELECT activity_id,count(*) FILTER(WHERE status IN ('pending','approved','rejected')) AS record_count,
        count(*) FILTER(WHERE status='pending') AS pending_count,count(*) FILTER(WHERE status='approved') AS approved_count,
        count(*) FILTER(WHERE status='rejected') AS rejected_count FROM volunteer_logs GROUP BY activity_id) c ON c.activity_id=a.id
      WHERE ${filter.join(' AND ')} ORDER BY a.created_at DESC`, params)).rows;
    return rows.map(classified);
  });
  app.get('/:id', async (request, reply) => {
    try {
      const activity = await find(db, request);
      const logs = (await db.query('SELECT * FROM volunteer_logs WHERE activity_id=$1', [activity.id])).rows;
      const state = await publication.current();
      const counts = {
        total: logs.length,
        pending: 0,
        approved: 0,
        rejected: 0,
        withdrawn: 0,
        voided: 0,
        published: 0,
        waiting_publication: 0
      };
      for (const log of logs) {
        counts[log.status] = (counts[log.status] || 0) + 1;
        if (log.status === 'approved') counts[publication.isPublished(state, log) ? 'published' : 'waiting_publication']++;
      }
      return {
        ...classified(activity),
        counts
      };
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    }
  });
  app.post('/', async (request, reply) => {
    try {
      const values = data(request.body || {}, request.user);
      const activity = (await db.query(`INSERT INTO activities(name,start_time,end_time,location,org_name,description,academic_year,academic_term,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [...values, request.user.id])).rows[0];
      await writeAudit(request, 'activity.create', 'activity', activity.id, {
        name: activity.name
      });
      return reply.code(201).send(activity);
    } catch (error) {
      if (error.statusCode) return reply.code(error.statusCode).send({
        message: error.message
      });
      throw error;
    }
  });
  async function mutate(request, reply, action) {
    const client = await db.pool.connect();
    let activity, syncedFields = [];
    try {
      await client.query('BEGIN');
      const before = await find(client, request, true);
      if (before.deleted_at && action !== 'restore') throw failure(409, '活动已删除，请先恢复');
      if (action === 'update') {
        const values = data(request.body || {}, request.user, before);
        const updates = [], params = [before.id];
        function syncField(field, value) {
          params.push(value); updates.push(`${field}=$${params.length}`); syncedFields.push(field);
        }
        if (values[0] !== before.name) syncField('activity_name', values[0]);
        const dateChanged = (await client.query(`SELECT
          ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date IS DISTINCT FROM
          ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AS changed`, [before.start_time, values[1]])).rows[0].changed;
        if (dateChanged) {
          params.push(values[1]); updates.push(`activity_date=($${params.length}::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`);
          syncedFields.push('activity_date');
          if (values[1]) {
            params.push(academic.LEGACY_LABEL);
            updates.push(`activity_period=CASE WHEN activity_period=$${params.length} THEN NULL ELSE activity_period END`);
          }
        }
        if (values[6] !== (before.academic_year || null)) syncField('academic_year', values[6]);
        if (values[7] !== (before.academic_term || null)) syncField('academic_term', values[7]);
        if (updates.length) {
          // Lock before checking approval so a concurrent review cannot change the permission boundary.
          const records = (await client.query('SELECT id,status FROM volunteer_logs WHERE activity_id=$1 ORDER BY id FOR UPDATE', [before.id])).rows;
          if (records.some(row => row.status === 'approved') && !hasCapability(request.user.role, 'reviews:manage')) {
            throw failure(403, '活动含已审核名单，修改活动名称、日期或归属需要复核权限，请联系办公室');
          }
        }
        activity = (await client.query(`UPDATE activities SET name=$2,start_time=$3,end_time=$4,location=$5,org_name=$6,
          description=$7,academic_year=$8,academic_term=$9 WHERE id=$1 RETURNING *`, [before.id, ...values])).rows[0];
        if (updates.length) await client.query(`UPDATE volunteer_logs SET ${updates.join(',')} WHERE activity_id=$1`, params);
      } else if (action === 'delete') {
        const count = (await client.query("SELECT count(*)::int AS count FROM volunteer_logs WHERE activity_id=$1 AND status IN ('pending','approved','rejected')", [before.id])).rows[0].count;
        if (count) throw failure(409, `活动仍有${count}条有效名单记录，请先撤回或作废记录，或选择归档`);
        activity = (await client.query('UPDATE activities SET deleted_at=now() WHERE id=$1 RETURNING *', [before.id])).rows[0];
      } else if (action === 'restore') {
        if (!before.deleted_at) throw failure(409, '活动未删除');
        activity = (await client.query('UPDATE activities SET deleted_at=NULL WHERE id=$1 RETURNING *', [before.id])).rows[0];
      } else {
        activity = (await client.query('UPDATE activities SET status=$2 WHERE id=$1 RETURNING *', [before.id, action === 'archive' ? 'archived' : 'active'])).rows[0];
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
    await writeAudit(request, `activity.${action}`, 'activity', activity.id, {
      name: activity.name,
      ...(syncedFields.length ? { synced_fields: syncedFields } : {})
    });
    return activity;
  }
  app.put('/:id', (request, reply) => mutate(request, reply, 'update'));
  app.delete('/:id', (request, reply) => mutate(request, reply, 'delete'));
  app.post('/:id/restore', (request, reply) => mutate(request, reply, 'restore'));
  app.patch('/:id/archive', (request, reply) => mutate(request, reply, 'archive'));
  app.patch('/:id/unarchive', (request, reply) => mutate(request, reply, 'unarchive'));
};
