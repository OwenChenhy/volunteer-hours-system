const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');

async function authRoutes(fastify, options) {
  fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body;

    try {
      const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
      if (result.rows.length === 0) {
        return reply.code(401).send({ message: '用户名或密码错误' });
      }

      const user = result.rows[0];
      if (!user.is_active) {
        return reply.code(403).send({ message: '账号已被禁用' });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return reply.code(401).send({ message: '用户名或密码错误' });
      }

      const payload = {
        id: user.id,
        username: user.username,
        real_name: user.real_name,
        role: user.role,
        org_name: user.org_name
      };
      const access_token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '2h' });
      const refresh_token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' });

      return {
        access_token,
        refresh_token,
        expires_in: 7200,
        user: payload
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ message: '服务器内部错误' });
    }
  });

  fastify.post('/refresh', async (request, reply) => {
    const { refresh_token } = request.body || {};
    if (!refresh_token) {
      return reply.code(400).send({ message: '缺少 refresh_token' });
    }

    try {
      const decoded = jwt.verify(refresh_token, process.env.JWT_SECRET);
      const payload = {
        id: decoded.id,
        username: decoded.username,
        real_name: decoded.real_name,
        role: decoded.role,
        org_name: decoded.org_name
      };
      const access_token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '2h' });

      return {
        access_token,
        expires_in: 7200,
        user: payload
      };
    } catch (err) {
      return reply.code(401).send({ message: 'refresh_token 无效或已过期' });
    }
  });

  fastify.post('/logout', async () => {
    return { success: true };
  });

  fastify.get('/me', {
    preValidation: [require('../middlewares/auth').authenticate]
  }, async (request, reply) => {
    return { user: request.user };
  });
}

module.exports = authRoutes;
