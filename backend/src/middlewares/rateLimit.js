/**
 * 查询限流中间件（基于 @fastify/rate-limit）
 * 每 IP 每分钟最多查询 10 次
 */

const rateLimitConfig = {
  max: 10,
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
    return request.headers['x-real-ip'] || request.ip;
  }
};

module.exports = rateLimitConfig;
