const queryService = require('../services/queryService');
const rateLimitConfig = require('../middlewares/rateLimit');

module.exports = async function (fastify, opts) {
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

      return result;
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ message: '服务器内部错误' });
    }
  });
};
