/**
 * 查询限流中间件（基于 @fastify/rate-limit）
 * 同一出口下每个学号每分钟最多查询10次，支持校园共享出口。
 */

const rateLimitConfig = {
  max: 10,
  hook: 'preHandler',
  timeWindow: '1 minute',
  errorResponse: (request, context) => {
    return {
      statusCode: 429,
      error: 'Too Many Requests',
      message: `请求过于频繁，请在 ${context.after} 后再试。`
    }
  },
  keyGenerator: (request) => {
    // Trust only the IP set by our reverse proxy. Client-controlled X-Forwarded-For is ignored.
    const ip = request.headers['x-real-ip'] || request.ip;
    const studentId = request.body?.student_id;
    return studentId ? `${ip}:${String(studentId).trim()}` : ip;
  }
};

module.exports = rateLimitConfig;
