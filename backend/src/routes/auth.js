const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const {
  authenticate
} = require('../middlewares/auth');
const {
  currentUser,
  publicUser
} = require('../services/sessionService');
function tokens(user) {
  const payload = {
    id: user.id,
    session_version: Number(user.session_version || 0)
  };
  const access_token = jwt.sign({
    ...payload,
    token_type: 'access'
  }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '2h'
  });
  const refresh_token = jwt.sign({
    ...payload,
    token_type: 'refresh'
  }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d'
  });
  const timing = jwt.decode(access_token);
  return {
    access_token,
    refresh_token,
    expires_in: timing.exp - timing.iat,
    user: publicUser(user)
  };
}
module.exports = async function (app) {
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: {
            type: 'string',
            minLength: 1,
            maxLength: 64
          },
          password: {
            type: 'string',
            minLength: 1,
            maxLength: 128
          }
        }
      }
    }
  }, async (request, reply) => {
    const {
      username,
      password
    } = request.body;
    const user = (await db.query('SELECT * FROM users WHERE username=$1', [username.trim()])).rows[0];
    if (!user || !user.is_active || user.deleted_at || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({
        message: '用户名或密码错误，或账号已停用'
      });
    }
    return tokens(user);
  });
  app.post('/refresh', async (request, reply) => {
    let decoded;
    try {
      decoded = jwt.verify(request.body?.refresh_token || '', process.env.JWT_SECRET);
      if (decoded.token_type !== 'refresh') throw new Error('wrong token type');
    } catch {
      return reply.code(401).send({
        message: '登录已失效，请重新登录'
      });
    }
    const user = await currentUser(decoded);
    if (!user) return reply.code(401).send({
      message: '账号状态或权限已变更，请重新登录'
    });
    return tokens(user);
  });
  app.post('/logout', {
    preHandler: [authenticate]
  }, async request => {
    await db.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [request.user.id]);
    return {
      success: true
    };
  });
  app.get('/me', {
    preHandler: [authenticate]
  }, async request => ({
    user: publicUser(request.user)
  }));
};
