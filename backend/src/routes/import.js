const db = require('../db');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');
const importService = require('../services/importService');
const { isExcelImportEnabled } = require('../utils/featureFlags');
const { writeAudit } = require('../services/auditService');
const cache = require('../cache/redis');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previewStore = new Map();

function cleanupPreviewStore() {
  const now = Date.now();
  for (const [id, preview] of previewStore.entries()) {
    if (now - preview.createdAt > PREVIEW_TTL_MS) {
      previewStore.delete(id);
    }
  }
}

function makePreviewRowKey(row) {
  return `${row?.sheet || ''}:${row?.row || ''}:${row?.student_id || ''}:${row?.student_name || ''}`;
}

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireCapability('import:manage'));

  // 预览 Excel
  fastify.post('/preview', async (request, reply) => {
    if (!isExcelImportEnabled()) {
      return reply.code(403).send({ message: 'Excel 导入功能已关闭' });
    }

    const data = await request.file();
    if (!data) return reply.code(400).send({ message: '请上传文件' });
    if (!/\.xlsx$/i.test(data.filename || '')) {
      return reply.code(400).send({ message: '仅支持 .xlsx 文件；旧版 .xls 请先另存为 .xlsx 后导入' });
    }

    const buffer = await data.toBuffer();
    const preview = await importService.parsePreview(buffer);
    cleanupPreviewStore();

    const previewId = crypto.randomUUID();
    previewStore.set(previewId, {
      userId: request.user.id,
      filename: data.filename,
      rows: preview.rows,
      createdAt: Date.now()
    });

    return {
      preview_id: previewId,
      filename: data.filename,
      ...preview
    };
  });

  // 确认导入
  fastify.post('/confirm', {
    schema: {
      body: {
        type: 'object',
        required: ['preview_id'],
        properties: {
          preview_id: { type: 'string' },
          confirmed_row_keys: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          filename: { type: 'string' },
          default_activity_date: { type: 'string' },
          default_activity_name: { type: 'string' },
          replace_existing_note: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    if (!isExcelImportEnabled()) {
      return reply.code(403).send({ message: 'Excel 导入功能已关闭' });
    }

    const {
      preview_id,
      confirmed_row_keys,
      note,
      default_activity_date,
      default_activity_name,
      replace_existing_note
    } = request.body;
    try {
      cleanupPreviewStore();
      const preview = previewStore.get(preview_id);
      if (!preview || preview.userId !== request.user.id) {
        return reply.code(400).send({ message: '预览已过期或不存在，请重新上传文件预览' });
      }

      const confirmedSet = new Set(confirmed_row_keys || []);
      const unconfirmedWarnings = preview.rows.filter(
        (row) => row.status === 'warning' && !confirmedSet.has(makePreviewRowKey(row))
      );
      if (unconfirmedWarnings.length > 0) {
        return reply.code(400).send({
          message: `还有 ${unconfirmedWarnings.length} 条问题数据未确认，请确认后再导入`
        });
      }

      const rows = preview.rows
        .filter((row) => row.status === 'ok' || (row.status === 'warning' && confirmedSet.has(makePreviewRowKey(row))))
        .map((row) => ({
          ...row,
          problem_confirmed: row.status === 'warning'
        }));

      if (rows.length === 0) {
        return reply.code(400).send({ message: '没有可导入的记录，请先确认问题行或修正原始数据' });
      }

      const result = await importService.confirmImport(rows, request.user.id, note, preview.filename, {
        default_activity_date,
        default_activity_name,
        replace_existing_note
      });
      previewStore.delete(preview_id);
      await writeAudit(request, 'import.confirm', 'import_batch', result.batch_id, {
        count: result.count,
        confirmed_problem_count: result.confirmed_problem_count,
        replaced_batch_count: result.replaced_batch_count,
        replaced_record_count: result.replaced_record_count,
        preview_id,
        filename: preview.filename,
        note
      });
      await cache.deleteByPrefix('query:');
      return result;
    } catch (err) {
      if (err.code === 'IMPORT_VALIDATION') {
        request.log.warn({ err }, 'Import confirmation rejected');
        return reply.code(400).send({ message: err.message || '导入确认失败' });
      }
      request.log.error({ err }, 'Import confirmation failed');
      return reply.code(500).send({ message: '导入确认失败，请稍后重试' });
    }
  });

  // 获取导入批次列表
  fastify.get('/batches', async (request, reply) => {
    const { rows } = await db.query('SELECT * FROM import_batches ORDER BY created_at DESC');
    return rows;
  });

  fastify.get('/template', async (request, reply) => {
    const headers = ['学号', '姓名', '学院', '年级', '活动名称', '活动日期', '服务时长（小时）', '联系方式'];
    const sample = ['TEST-STUDENT-003', '测试用户', '计算机科学与工程学院', '25级', '社区志愿服务', '2026-04-25', 2.5, ''];
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('标准导入模板');
    worksheet.addRows([headers, sample]);
    worksheet.columns.forEach((column) => {
      column.width = 18;
    });
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="volunteer-import-template.xlsx"')
      .send(buffer);
  });
};

