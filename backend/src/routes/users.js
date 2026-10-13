const bcrypt = require('bcrypt');
const db = require('../db');
const { authenticate } = require('../middlewares/auth');
const { ROLE_LABELS, requireCapability } = require('../middlewares/rbac');
const { UUID } = require('../services/sessionService');
const { writeAudit } = require('../services/auditService');
const { normalizeCollegeName, isFormalCollegeName } = require('../utils/collegeNames');

const fields = 'id,username,real_name,role,org_name,is_active,created_at,deleted_at';
function profile(body) {
  const real_name = String(body.real_name || '').trim();
  const role = body.role;
  const org_name = normalizeCollegeName(body.org_name || '') || null;
  if (!real_name || real_name.length > 64 || !Object.hasOwn(ROLE_LABELS, role)) throw failure(400, '请填写姓名并选择有效角色');
  if (role === 'college_admin' && (!org_name || !isFormalCollegeName(org_name))) throw failure(400, '学院管理员必须选择正式学院名称');
  if ((org_name || '').length > 128) throw failure(400, '所属单位名称过长');
  return { real_name, role, org_name };
}
function failure(status, message) { return Object.assign(new Error(message), { statusCode: status }); }

module.exports = async function (app) {
  app.addHook('preValidation', authenticate);
  app.get('/operation-logs', { preHandler: [requireCapability('audit:read')] }, async request =>
    (await db.query(`SELECT id,username,action,target_type,target_id,detail,ip,created_at FROM operation_logs
      ${request.user.role==='college_admin'?'WHERE user_id=$1':''} ORDER BY created_at DESC LIMIT 200`,
      request.user.role==='college_admin'?[request.user.id]:[])).rows);
  app.get('/roles', { preHandler: [requireCapability('*')] }, async () => Object.entries(ROLE_LABELS).map(([value,label]) => ({ value,label })));
  app.get('/', { preHandler: [requireCapability('*')] }, async (request) =>
    (await db.query(`SELECT ${fields} FROM users ${request.query.include_deleted === 'true' ? '' : 'WHERE deleted_at IS NULL'} ORDER BY created_at DESC`)).rows);

  app.post('/', { preHandler: [requireCapability('*')] }, async (request, reply) => {
    try {
      const body = request.body || {};
      const data = profile(body), username = String(body.username || '').trim();
      if (!username || username.length > 64 || typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) throw failure(400, '用户名不能为空，密码须为8至128位');
      const hash = await bcrypt.hash(body.password, 12);
      const user = (await db.query(`INSERT INTO users(username,password_hash,real_name,role,org_name) VALUES($1,$2,$3,$4,$5) RETURNING ${fields}`,
        [username, hash, data.real_name, data.role, data.org_name])).rows[0];
      await writeAudit(request, 'users.create', 'user', user.id, { username, role: data.role });
      return reply.code(201).send(user);
    } catch (error) {
      if (error.code === '23505') return reply.code(409).send({ message: '用户名已存在' });
      if (error.statusCode) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    }
  });

  async function change(request, reply, action) {
    const id = request.params.id;
    if (!UUID.test(id)) return reply.code(400).send({ message: '账号编号无效' });
    const client = await db.pool.connect();
    let updated, detail = {};
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(927643)');
      const before = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!before) throw failure(404, '账号不存在');
      if (before.deleted_at && action !== 'restore') throw failure(409, '账号已删除，请先恢复');
      let data;
      if (action === 'update') data = profile(request.body || {});
      const removesAccess = action === 'delete' || (action === 'toggle_active' && before.is_active)
        || (action === 'update' && !['admin','super_admin'].includes(data.role));
      if (removesAccess && id === request.user.id) throw failure(409, '不能删除、停用或降低当前登录账号的管理权限');
      if (removesAccess && before.is_active && ['admin','super_admin'].includes(before.role)) {
        const count = (await client.query("SELECT count(*)::int AS count FROM users WHERE is_active AND deleted_at IS NULL AND role IN ('admin','super_admin') AND id<>$1", [id])).rows[0].count;
        if (!count) throw failure(409, '必须保留至少一个可登录的管理员');
      }
      if (action === 'delete') {
        updated = (await client.query(`UPDATE users SET deleted_at=now(),is_active=false,session_version=session_version+1 WHERE id=$1 RETURNING ${fields}`, [id])).rows[0];
      } else if (action === 'restore') {
        if (!before.deleted_at) throw failure(409, '账号未删除');
        updated = (await client.query(`UPDATE users SET deleted_at=NULL,is_active=false,session_version=session_version+1 WHERE id=$1 RETURNING ${fields}`, [id])).rows[0];
        detail = { note: '恢复后仍为停用状态，启用前请核对角色和所属单位' };
      } else if (action === 'toggle_active') {
        updated = (await client.query(`UPDATE users SET is_active=NOT is_active,session_version=session_version+1 WHERE id=$1 RETURNING ${fields}`, [id])).rows[0];
        detail = { is_active: updated.is_active };
      } else if (action === 'update') {
        const invalidate = before.role !== data.role || before.org_name !== data.org_name;
        updated = (await client.query(`UPDATE users SET real_name=$2,role=$3,org_name=$4,session_version=session_version+$5 WHERE id=$1 RETURNING ${fields}`,
          [id,data.real_name,data.role,data.org_name,invalidate ? 1 : 0])).rows[0];
        detail = { before: { role: before.role, org_name: before.org_name }, after: data };
      } else {
        const password = request.body?.new_password;
        if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw failure(400, '新密码须为8至128位');
        await client.query('UPDATE users SET password_hash=$2,session_version=session_version+1 WHERE id=$1', [id,await bcrypt.hash(password,12)]);
        updated = { id, message: '密码已更新，该账号的旧登录会话已失效' };
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.statusCode) return reply.code(error.statusCode).send({ message: error.message });
      throw error;
    } finally { client.release(); }
    await writeAudit(request, `users.${action}`, 'user', id, detail);
    return updated;
  }
  const guard = { preHandler: [requireCapability('*')] };
  app.patch('/:id', guard, (request,reply) => change(request,reply,'update'));
  app.delete('/:id', guard, (request,reply) => change(request,reply,'delete'));
  app.post('/:id/restore', guard, (request,reply) => change(request,reply,'restore'));
  app.patch('/:id/toggle-active', guard, (request,reply) => change(request,reply,'toggle_active'));
  app.post('/:id/reset-password', guard, (request,reply) => change(request,reply,'reset_password'));
};
