const db = require('../db');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const { getDraftDataVersion: getDataVersion, makeVerificationCode, queryDraftStudentLogs: queryStudentLogs } = require('../services/queryService');
const { normalizeCollegeName } = require('../utils/collegeNames');

module.exports = async function (fastify) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireCapability('stats:read'));

  fastify.post('/', async (request, reply) => {
    const mode = String(request.body?.mode || '').trim();
    const value = String(request.body?.value || '').trim();
    const otherValue = String(request.body?.other_value || '').trim();
    const page = request.body?.page === undefined ? 1 : Number(request.body.page);
    if (!Number.isInteger(page) || page < 1 || page > 100000 || otherValue.length > 80) return reply.code(400).send({ message: '页码或联合查询条件无效' });
    if (!['student_id', 'student_name', 'verification_code'].includes(mode) || !value || value.length > 80) {
      return reply.code(400).send({ message: '请选择查询方式并输入有效内容' });
    }
    if (mode === 'verification_code' && !/^[a-f0-9]{12}$/i.test(value)) {
      return reply.code(400).send({ message: '校验码应为 12 位十六进制字符' });
    }
    if (request.user.role === 'college_admin' && mode === 'verification_code') {
      return reply.code(403).send({ message: '学院管理员请使用学号或姓名查询本学院记录' });
    }

    const params = [];
    let filter = '';
    let college = null;
    if (request.user.role === 'college_admin') {
      if (!request.user.org_name) return reply.code(403).send({ message: '账号未配置所属学院' });
      college = normalizeCollegeName(request.user.org_name);
      params.push(college);
      filter += ` AND college = $${params.length}`;
    }
    if (mode !== 'verification_code') {
      params.push(value);
      filter += ` AND ${mode} = $${params.length}`;
    }
    if (otherValue && mode !== 'verification_code') {
      params.push(otherValue);
      filter += ` AND ${mode === 'student_id' ? 'student_name' : 'student_id'} = $${params.length}`;
    }
    const result = await db.query(`
      SELECT student_id, student_name, SUM(hours)::numeric AS total_hours, COUNT(*)::int AS record_count
      FROM volunteer_logs
      WHERE status = 'approved'${filter}
      GROUP BY student_id, student_name
      ORDER BY student_id, student_name
    `, params);
    const version = await getDataVersion();
    const candidates = mode === 'verification_code'
      ? result.rows.filter((row) => makeVerificationCode(
        row.student_id,
        row.student_name,
        Number(row.total_hours),
        row.record_count,
        version.batch_id
      ) === value.toUpperCase())
      : result.rows;
    const selected = candidates.slice((page - 1) * 20, page * 20);
    const matches = await Promise.all(selected.map((row) => queryStudentLogs(row.student_id, row.student_name, college)));

    return {
      total_matches: candidates.length,
      truncated: candidates.length > page * 20,
      page,
      page_size: 20,
      matches: matches.filter(Boolean),
    };
  });
};
