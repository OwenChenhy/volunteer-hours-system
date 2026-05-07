const statsService = require('../services/statsService');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const ExcelJS = require('exceljs');

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireCapability('stats:read'));

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
