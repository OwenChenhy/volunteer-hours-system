const db = require('../db');
const academic = require('../services/academicService');
const { authenticate } = require('../middlewares/auth');
const { isOrganizer, hasFullAccess } = require('../middlewares/rbac');
const { writeAudit } = require('../services/auditService');

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/', async (request, reply) => {
    let query;
    let params = [];

    if (hasFullAccess(request.user)) {
      query = "SELECT *, (start_time AT TIME ZONE 'Asia/Shanghai')::date AS activity_date FROM activities ORDER BY created_at DESC";
    } else {
      query = "SELECT *, (start_time AT TIME ZONE 'Asia/Shanghai')::date AS activity_date FROM activities WHERE created_by = $1 ORDER BY created_at DESC";
      params = [request.user.id];
    }

    const { rows } = await db.query(query, params);
    return rows.map((row) => ({ ...row, ...academic.classify(row), academic_year_inferred: !row.academic_year, academic_term_inferred: !row.academic_term }));
  });

  fastify.post('/', {
    preHandler: [isOrganizer],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'start_time', 'end_time'],
        properties: {
          name: { type: 'string' },
          start_time: { type: 'string', format: 'date-time' },
          end_time: { type: 'string', format: 'date-time' },
          location: { type: 'string' },
          org_name: { type: 'string' },
          description: { type: 'string' },
          academic_year: { type: 'string' },
          academic_term: { type: 'string', enum: ['', 'upper', 'lower', 'vacation', 'unassigned'] }
        }
      }
    }
  }, async (request, reply) => {
    const { name, start_time, end_time, location, org_name, description, academic_year, academic_term } = request.body;
    if (academic_year && !academic.validYear(academic_year)) return reply.code(400).send({ message: '学年格式无效' });
    if (new Date(end_time) < new Date(start_time)) return reply.code(400).send({ message: '结束时间不能早于开始时间' });
    const userId = request.user.id;

    const query = `
      INSERT INTO activities (name, start_time, end_time, location, org_name, description, created_by, academic_year, academic_term)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    const { rows } = await db.query(query, [name, start_time, end_time, location, org_name, description, userId, academic_year || null, academic_term || null]);
    await writeAudit(request, 'activity.create', 'activity', rows[0].id, { name });
    return reply.code(201).send(rows[0]);
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params;
    const { rows } = await db.query('SELECT * FROM activities WHERE id = $1', [id]);

    if (rows.length === 0) {
      return reply.code(404).send({ message: '活动不存在' });
    }

    const activity = rows[0];
    if (!hasFullAccess(request.user) && activity.created_by !== request.user.id) {
      return reply.code(403).send({ message: '权限不足' });
    }

    return activity;
  });

  fastify.put('/:id', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'start_time', 'end_time'],
        properties: {
          name: { type: 'string' },
          start_time: { type: 'string', format: 'date-time' },
          end_time: { type: 'string', format: 'date-time' },
          location: { type: 'string' },
          org_name: { type: 'string' },
          description: { type: 'string' },
          academic_year: { type: 'string' },
          academic_term: { type: 'string', enum: ['', 'upper', 'lower', 'vacation', 'unassigned'] }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { name, start_time, end_time, location, org_name, description, academic_year, academic_term } = request.body;
    if (academic_year && !academic.validYear(academic_year)) return reply.code(400).send({ message: '学年格式无效' });
    if (new Date(end_time) < new Date(start_time)) return reply.code(400).send({ message: '结束时间不能早于开始时间' });

    const checkRes = await db.query('SELECT created_by FROM activities WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ message: '活动不存在' });
    }

    if (!hasFullAccess(request.user) && checkRes.rows[0].created_by !== request.user.id) {
      return reply.code(403).send({ message: '权限不足' });
    }

    const client = await db.pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      ({ rows } = await client.query(`UPDATE activities SET name = $1, start_time = $2, end_time = $3, location = $4, org_name = $5, description = $6, academic_year = $8, academic_term = $9 WHERE id = $7 RETURNING *`, [name, start_time, end_time, location, org_name, description, id, academic_year || null, academic_term || null]));
      await client.query(`UPDATE volunteer_logs SET activity_name = $1, activity_date = ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date, academic_year = $3, academic_term = $4 WHERE activity_id = $5`, [name, start_time, academic_year || null, academic_term || null, id]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }

    await writeAudit(request, 'activity.update', 'activity', id, { name });
    return rows[0];
  });

  fastify.patch('/:id/archive', async (request, reply) => {
    const { id } = request.params;

    const checkRes = await db.query('SELECT created_by FROM activities WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ message: '活动不存在' });
    }

    if (!hasFullAccess(request.user) && checkRes.rows[0].created_by !== request.user.id) {
      return reply.code(403).send({ message: '权限不足' });
    }

    const { rows } = await db.query(
      "UPDATE activities SET status = 'archived' WHERE id = $1 RETURNING *",
      [id]
    );
    await writeAudit(request, 'activity.archive', 'activity', id);
    return rows[0];
  });

  fastify.patch('/:id/unarchive', async (request, reply) => {
    const { id } = request.params;
    const checkRes = await db.query('SELECT created_by FROM activities WHERE id = $1', [id]);
    if (checkRes.rows.length === 0) {
      return reply.code(404).send({ message: '活动不存在' });
    }
    if (!hasFullAccess(request.user) && checkRes.rows[0].created_by !== request.user.id) {
      return reply.code(403).send({ message: '权限不足' });
    }
    const { rows } = await db.query(
      "UPDATE activities SET status = 'active' WHERE id = $1 RETURNING *",
      [id]
    );
    await writeAudit(request, 'activity.unarchive', 'activity', id);
    return rows[0];
  });
};
