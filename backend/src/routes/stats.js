const statsService = require('../services/statsService');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const ExcelJS = require('exceljs');
const academic = require('../services/academicService');
const { normalizeCollegeName } = require('../utils/collegeNames');

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireCapability('stats:read'));

  fastify.get('/academic-summary', { schema: { querystring: { type: 'object', required: ['academic_year'], properties: { academic_year: { type: 'string', maxLength: 9 }, college: { type: 'string', maxLength: 128 }, grade: { type: 'string', maxLength: 16 }, page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async (request, reply) => {
    const input = { ...request.query };
    if (!academic.validYear(input.academic_year)) return reply.code(400).send({ message: '请填写连续两年的学年，例如 2025-2026' });
    if (input.college) input.college = normalizeCollegeName(input.college);
    if (request.user.role === 'college_admin') {
      if (!request.user.org_name) return reply.code(403).send({ message: '账号未配置所属学院' });
      input.college = normalizeCollegeName(request.user.org_name);
    }
    reply.header('Cache-Control', 'no-store');
    return { ...(await academic.getSummary(input)), rules: academic.rules() };
  });

  // 全局概览
  fastify.get('/overview', async (request, reply) => {
    return await statsService.getOverview();
  });

  // 按学院统计
  fastify.get('/by-college', async (request, reply) => {
    return await statsService.getByCollege();
  });

  // 按月统计
  fastify.get('/by-month', async (request, reply) => {
    return await statsService.getByMonth();
  });

  fastify.get('/rankings', async (request, reply) => {
    return await statsService.getRankings();
  });

  fastify.get('/problems', async (request, reply) => {
    return await statsService.getProblemStats();
  });

  fastify.get('/export', async (request, reply) => {
    const [overview, byCollege, byMonth] = await Promise.all([
      statsService.getOverview(),
      statsService.getByCollege(),
      statsService.getByMonth()
    ]);

    const workbook = new ExcelJS.Workbook();
    addJsonSheet(workbook, '概览', [overview]);
    addJsonSheet(workbook, '按学院统计', byCollege);
    addJsonSheet(workbook, '按月统计', byMonth);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="volunteer-stats.xlsx"')
      .send(buffer);
  });
};

function addJsonSheet(workbook, name, rows) {
  const worksheet = workbook.addWorksheet(name);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  worksheet.addRow(keys);
  for (const row of rows) {
    worksheet.addRow(keys.map((key) => row?.[key] ?? ''));
  }
  worksheet.columns.forEach((column) => {
    column.width = 18;
  });
}
