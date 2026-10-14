require('dotenv').config();
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const multipart = require('@fastify/multipart');
const rateLimit = require('@fastify/rate-limit');
const { ensureSchema } = require('./db/ensureSchema');

function buildApp() {
  const app = Fastify({
    logger: true,
    bodyLimit: 1048576 * 10 // 10MB
  });
  app.addHook('onClose', async () => require('./cache/redis').close());

  // 基础插件注册
  app.register(cors, {
    origin: '*'
  });

  app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024 // 10MB
    }
  });

  // 限流配置（默认 1 分钟 100 次，查询接口单独在路由中覆盖）
  app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.headers['x-real-ip'] || request.ip
  });

  // 路由注册
  app.register(require('./routes/auth'), { prefix: '/api/v1/auth' });
  app.register(require('./routes/query'), { prefix: '/api/v1/query' });
  app.register(require('./routes/activities'), { prefix: '/api/v1/activities' });
  app.register(require('./routes/logs'), { prefix: '/api/v1/logs' });
  app.register(require('./routes/import'), { prefix: '/api/v1/import' });
  app.register(require('./routes/stats'), { prefix: '/api/v1/stats' });
  app.register(require('./routes/users'), { prefix: '/api/v1/users' });
  app.register(require('./routes/reviews'), { prefix: '/api/v1/reviews' });
  app.register(require('./routes/ops'), { prefix: '/api/v1/ops' });
  app.register(require('./routes/adminSearch'), { prefix: '/api/v1/admin-search' });
  app.register(require('./routes/publications'), { prefix: '/api/v1/publications' });
  app.register(require('./routes/publicStatus'), { prefix: '/api/v1/ops/public-status' });

  // 健康检查
  app.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return app;
}

const start = async () => {
  const app = buildApp();
  try {
    await ensureSchema();
    await require('./services/publicationService').current();
    const port = process.env.PORT || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`服务器运行在 http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { buildApp };
