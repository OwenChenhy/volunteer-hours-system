const jwt = require('jsonwebtoken');

const authenticate = async (request, reply) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ message: '未授权，缺少Token' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    request.user = decoded; // { id, role, etc. }
  } catch (err) {
    return reply.code(401).send({ message: 'Token无效或已过期' });
  }
};

const requireRole = (role) => {
  return async (request, reply) => {
    if (request.user.role !== role && request.user.role !== 'admin') {
      return reply.code(403).send({ message: '权限不足' });
    }
  };
};

module.exports = { authenticate, requireRole };