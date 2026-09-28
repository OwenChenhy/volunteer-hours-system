const queryService = require('../services/queryService');
const rateLimitConfig = require('../middlewares/rateLimit');
const db = require('../db');

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

  fastify.get('/meta', async () => {
    return await queryService.getDataVersion();
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

      return result;
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ message: '服务器内部错误' });
    }
  });
};
