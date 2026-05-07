const bcrypt = require('bcrypt');
const db = require('../db');
const { authenticate } = require('../middlewares/auth');
const { ROLE_LABELS, requireCapability } = require('../middlewares/rbac');
const { writeAudit } = require('../services/auditService');

async function userRoutes(fastify, options) {
  fastify.addHook('preValidation', authenticate);

  // 获取用户列表
  fastify.get('/', { preHandler: [requireCapability('*')] }, async (request, reply) => {
    try {
      const result = await db.query(
        'SELECT id, username, real_name, role, org_name, is_active, created_at FROM users ORDER BY created_at DESC'
      );
      return result.rows;
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ message: '获取用户列表失败' });
    }
  });

  fastify.get('/roles', { preHandler: [requireCapability('*')] }, async () => {
    return Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
  });

  fastify.get('/operation-logs', { preHandler: [requireCapability('audit:read')] }, async (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 200, 1000);
    const result = await db.query(`
      SELECT id, username, action, target_type, target_id, detail, ip, created_at
      FROM operation_logs
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  });

  // 创建用户
  fastify.post('/', { preHandler: [requireCapability('*')] }, async (request, reply) => {
    const { username, password, real_name, role, org_name } = request.body;
    try {
      const password_hash = await bcrypt.hash(password, 12);
      const result = await db.query(
        'INSERT INTO users (username, password_hash, real_name, role, org_name) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, real_name, role, org_name, is_active, created_at',
        [username, password_hash, real_name, role, org_name]
      );
      await writeAudit(request, 'users.create', 'user', result.rows[0].id, { username, role });
      return result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(400).send({ message: '用户名已存在' });
      }
      request.log.error(err);
      return reply.code(500).send({ message: '创建用户失败' });
    }
  });

  // 启用/禁用账号
  fastify.patch('/:id/toggle-active', { preHandler: [requireCapability('*')] }, async (request, reply) => {
    const { id } = request.params;
    try {
      const result = await db.query(
        'UPDATE users SET is_active = NOT is_active WHERE id = $1 RETURNING id, is_active',
        [id]
      );
      if (result.rows.length === 0) return reply.code(404).send({ message: '用户不存在' });
      await writeAudit(request, 'users.toggle_active', 'user', id, { is_active: result.rows[0].is_active });
      return result.rows[0];
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ message: '操作失败' });
    }
  });

  // 重置密码
  fastify.post('/:id/reset-password', { preHandler: [requireCapability('*')] }, async (request, reply) => {
    const { id } = request.params;
    const { new_password } = request.body;
    try {
      const password_hash = await bcrypt.hash(new_password, 12);
      const result = await db.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id',
        [password_hash, id]
      );
      if (result.rows.length === 0) return reply.code(404).send({ message: '用户不存在' });
      await writeAudit(request, 'users.reset_password', 'user', id);
      return { message: '密码重置成功' };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ message: '重置密码失败' });
    }
  });
}

module.exports = userRoutes;
