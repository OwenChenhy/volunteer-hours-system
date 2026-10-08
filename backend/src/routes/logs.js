const db = require('../db');
const { authenticate } = require('../middlewares/auth');
const { isOrganizer, requireCapability, hasCapability, hasFullAccess } = require('../middlewares/rbac');
const { writeAudit } = require('../services/auditService');
const { normalizeCollegeName, isFormalCollegeName } = require('../utils/collegeNames');

module.exports = async function (fastify, opts) {
fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.user?.role !== 'college_admin') return;
    if (!request.user.org_name) return reply.code(403).send({ message: '账号未配置所属学院' });
    if (request.method === 'GET') return;
    const ids = request.params?.id ? [request.params.id] : Array.isArray(request.body?.ids) ? [...new Set(request.body.ids)] : [];
    if (!ids.length) return;
    if (ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return reply.code(400).send({ message: '记录编号无效' });
    const permitted = await db.query('SELECT id FROM volunteer_logs WHERE id = ANY($1::uuid[]) AND college = $2', [ids, normalizeCollegeName(request.user.org_name)]);
    if (permitted.rows.length !== ids.length) return reply.code(403).send({ message: '只能处理所属学院的记录' });
  });

  // 获取记录列表（支持筛选）
  fastify.get('/', async (request, reply) => {
    const { status, source, activity_id, student_id, legacy_unprocessed, limit = 200 } = request.query;
    let query = 'SELECT * FROM volunteer_logs WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (source) {
      params.push(source);
      query += ` AND source = $${params.length}`;
    }
    if (activity_id) {
      params.push(activity_id);
      query += ` AND activity_id = $${params.length}`;
    }
    if (student_id) {
      params.push(student_id);
      query += ` AND student_id = $${params.length}`;
    }
    if (legacy_unprocessed === 'true') {
      query += " AND source = 'imported' AND is_legacy_processed = false";
    }

    // 组织者仅见自己提交的（或自己活动的）
    if (request.user.role === 'college_admin' && request.user.org_name) {
      params.push(normalizeCollegeName(request.user.org_name));
      query += ` AND college = $${params.length}`;
    } else if (!hasFullAccess(request.user) && !hasCapability(request.user.role, 'logs:review')) {
      params.push(request.user.id);
      query += ` AND (submitted_by = $${params.length})`;
    }

    params.push(Math.min(Number(limit) || 200, 1000));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await db.query(query, params);
    return rows;
  });

  // 批量提交时长记录（组织者）
  fastify.post('/', {
    preHandler: [isOrganizer],
    schema: {
      body: {
        type: 'object',
        required: ['activity_id', 'records'],
        properties: {
          activity_id: { type: 'string' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              required: ['student_id', 'student_name', 'hours'],
              properties: {
                student_id: { type: 'string' },
                student_name: { type: 'string' },
                college: { type: 'string' },
                grade: { type: 'string' },
                hours: { type: 'number' },
                phone: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { activity_id, records } = request.body;
    const userId = request.user.id;
    if (!Array.isArray(records) || records.length === 0) {
      return reply.code(400).send({ message: 'records 不能为空' });
    }

    // 获取活动信息以冗余存储
    const actRes = await db.query("SELECT name, created_by, academic_year, academic_term, (start_time AT TIME ZONE 'Asia/Shanghai')::date AS activity_date FROM activities WHERE id = $1", [activity_id]);
    if (actRes.rows.length === 0) {
      return reply.code(404).send({ message: '关联活动不存在' });
    }
    const activity = actRes.rows[0];
    if (!hasFullAccess(request.user) && activity.created_by !== request.user.id) return reply.code(403).send({ message: '只能提交自己负责活动的记录' });
    for (const record of records) {
      if (!String(record.student_id || '').trim() || !String(record.student_name || '').trim() || !Number.isFinite(record.hours) || record.hours <= 0 || record.hours > 9999.9) return reply.code(400).send({ message: '学生身份和正数服务时长必须有效' });
      const college = normalizeCollegeName(record.college);
      if (college && !isFormalCollegeName(college)) {
        return reply.code(400).send({ message: `学院不在正式名称列表：${college}` });
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of records) {
        const college = normalizeCollegeName(record.college) || null;
        const query = `
          INSERT INTO volunteer_logs (
            student_id, student_name, college, grade, activity_id, activity_name, activity_date,
            hours, phone, source, status, submitted_by, academic_year, academic_term
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'online', 'pending', $10, $11, $12)
        `;
        await client.query(query, [
          String(record.student_id || '').trim(),
          String(record.student_name || '').trim(),
          college,
          record.grade || null,
          activity_id,
          activity.name,
          activity.activity_date,
          record.hours,
          record.phone || null,
          userId,
          activity.academic_year || null,
          activity.academic_term || null
        ]);
      }
      await client.query('COMMIT');
      await writeAudit(request, 'logs.submit', 'activity', activity_id, { count: records.length });
      return reply.code(201).send({ message: `成功提交 ${records.length} 条记录，等待审核` });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // 审核通过（管理员）
  fastify.patch('/:id/approve', { preHandler: [requireCapability('logs:review')] }, async (request, reply) => {
    const { id } = request.params;
    const query = `
      UPDATE volunteer_logs 
      SET status = 'approved', reviewed_by = $1, reviewed_at = now()
      WHERE id = $2 RETURNING *
    `;
    const { rows } = await db.query(query, [request.user.id, id]);
    if (rows.length === 0) return reply.code(404).send({ message: '记录不存在' });
    await writeAudit(request, 'logs.approve', 'volunteer_log', id);
    return rows[0];
  });

  // 批量通过（管理员）
  fastify.post('/batch-approve', { preHandler: [requireCapability('logs:review')] }, async (request, reply) => {
    const { ids } = request.body;
    if (!Array.isArray(ids)) return reply.code(400).send({ message: 'ids 必须是数组' });

    const query = `
      UPDATE volunteer_logs 
      SET status = 'approved', reviewed_by = $1, reviewed_at = now()
      WHERE id = ANY($2) AND status = 'pending'
      RETURNING id
    `;
    const { rows } = await db.query(query, [request.user.id, ids]);
    await writeAudit(request, 'logs.batch_approve', null, null, { ids, count: rows.length });
    return { count: rows.length };
  });

  // 审核驳回（管理员）
  fastify.patch('/:id/reject', { preHandler: [requireCapability('logs:review')] }, async (request, reply) => {
    const { id } = request.params;
    const { reason } = request.body;
    const query = `
      UPDATE volunteer_logs 
      SET status = 'rejected', reject_reason = $1, reviewed_by = $2, reviewed_at = now()
      WHERE id = $3 RETURNING *
    `;
    const { rows } = await db.query(query, [reason, request.user.id, id]);
    if (rows.length === 0) return reply.code(404).send({ message: '记录不存在' });
    await writeAudit(request, 'logs.reject', 'volunteer_log', id, { reason });
    return rows[0];
  });

  // 标记导入记录已处理（管理员）
  fastify.patch('/:id/mark-processed', { preHandler: [requireCapability('logs:review')] }, async (request, reply) => {
    const { id } = request.params;
    const query = `
      UPDATE volunteer_logs 
      SET is_legacy_processed = true
      WHERE id = $1 AND source = 'imported' RETURNING *
    `;
    const { rows } = await db.query(query, [id]);
    if (rows.length === 0) return reply.code(404).send({ message: '导入记录不存在' });
    await writeAudit(request, 'logs.mark_processed', 'volunteer_log', id);
    return rows[0];
  });
};
