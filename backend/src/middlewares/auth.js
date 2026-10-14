const jwt = require('jsonwebtoken');
const { currentUser } = require('../services/sessionService');

const authenticate = async (request, reply) => {
  const value = request.headers.authorization;
  if (!value || !value.startsWith('Bearer ')) return reply.code(401).send({ message: '请先登录' });
  let decoded;
  try {
    decoded = jwt.verify(value.slice(7), process.env.JWT_SECRET);
    if (decoded.token_type && decoded.token_type !== 'access') throw new Error('wrong token type');
  } catch {
    return reply.code(401).send({ message: '登录已失效，请重新登录' });
  }
  try {
    const user = await currentUser(decoded);
    if (!user) return reply.code(401).send({ message: '账号状态或权限已变更，请重新登录' });
    request.user = user;
  } catch (error) {
    request.log.error({ code: error.code }, 'Account validation unavailable');
    return reply.code(503).send({ message: '暂时无法校验账号，请稍后重试' });
  }
};

module.exports = { authenticate, requireRole: require('./rbac').requireRole };
