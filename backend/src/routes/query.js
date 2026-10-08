const queryService = require('../services/queryService');
const rateLimitConfig = require('../middlewares/rateLimit');
const db = require('../db');
const academic = require('../services/academicService');

module.exports = async function (fastify, opts) {
  fastify.get('/metrics', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await db.query("SELECT name, value FROM public_counters WHERE name IN ('query_page_visits', 'student_queries')");
    const values = Object.fromEntries(result.rows.map((row) => [row.name, Number(row.value)]));
    return { visits: values.query_page_visits || 0, queries: values.student_queries || 0 };
  });

  fastify.post('/visit', async (request, reply) => {
    const result = await db.query(`
      INSERT INTO public_counters (name, value) VALUES ('query_page_visits', 1)
      ON CONFLICT (name) DO UPDATE SET value = public_counters.value + 1, updated_at = now()
      RETURNING value
    `);
    reply.header('Cache-Control', 'no-store');
    return { visits: Number(result.rows[0].value) };
  });

fastify.get('/meta', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return await queryService.getDataVersion();
  });

  fastify.post('/summary', {
    config: { rateLimit: rateLimitConfig },
    schema: { body: { type: 'object', required: ['student_id', 'student_name', 'academic_year'], properties: {
      student_id: { type: 'string', minLength: 1, maxLength: 32 }, student_name: { type: 'string', minLength: 1, maxLength: 64 },
      academic_year: { type: 'string', pattern: '^20[0-9]{2}-20[0-9]{2}$' }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }
    } } }
  }, async (request, reply) => {
    const input = request.body;
    if (!academic.validYear(input.academic_year)) return reply.code(400).send({ message: '学年必须为相邻两年' });
    const identity = await db.query("SELECT college, grade FROM volunteer_logs WHERE student_id = $1 AND student_name = $2 AND status = 'approved' ORDER BY activity_date DESC, created_at DESC LIMIT 1", [input.student_id.trim(), input.student_name.trim()]);
    if (!identity.rows.length) return reply.code(404).send({ message: '未找到匹配人员' });
    const person = identity.rows[0];
    if (!person.college || !person.grade) return reply.code(409).send({ message: '学院或年级信息缺失，请先联系办公室核对' });
    const summary = await academic.getSummary({ academic_year: input.academic_year, page: input.page, limit: input.limit, college: person.college, grade: person.grade });
    summary.rows = summary.rows.map((row) => {
      const self = row.student_id === input.student_id.trim() && row.student_name === input.student_name.trim();
      return { ...row, is_self: self, student_id: self ? row.student_id : (row.student_id.length > 4 ? '*'.repeat(row.student_id.length - 4) + row.student_id.slice(-4) : '*'.repeat(row.student_id.length)), student_name: self ? row.student_name : (row.student_name.length > 1 ? row.student_name.slice(0, 1) + '*'.repeat(row.student_name.length - 1) : '*') };
    });
    reply.header('Cache-Control', 'no-store');
    return { ...summary, college: person.college, grade: person.grade, data_version: await queryService.getDataVersion() };
  });

  // 公开查询接口，带限流
  fastify.post('/', {
    config: {
      rateLimit: rateLimitConfig
    },
    schema: {
      body: {
        type: 'object',
        required: ['student_id', 'student_name'],
        properties: {
          student_id: { type: 'string' },
          student_name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { student_id, student_name } = request.body;

    try {
      const result = await queryService.queryStudentLogs(student_id, student_name);

      if (!result) {
        return reply.code(404).send({ message: '未找到记录' });
      }

      try {
        await db.query(`
          INSERT INTO public_counters (name, value) VALUES ('student_queries', 1)
          ON CONFLICT (name) DO UPDATE SET value = public_counters.value + 1, updated_at = now()
        `);
      } catch (counterError) {
        fastify.log.error(counterError, 'Failed to update query counter');
      }

      reply.header('Cache-Control', 'no-store');
      return result;
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ message: '服务器内部错误' });
    }
  });
};
