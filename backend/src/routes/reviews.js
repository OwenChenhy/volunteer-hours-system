const db = require('../db');
const fs = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');
const { authenticate } = require('../middlewares/auth');
const { requireCapability, hasFullAccess } = require('../middlewares/rbac');
const { writeAudit } = require('../services/auditService');
const { normalizeCollegeName, isFormalCollegeName } = require('../utils/collegeNames');

const DATASET_NAME = '2025-2026志愿者时长库3月公示';
const PROBLEM_STATUSES = ['summary_conflict', 'summary_no_detail', 'supplement', 'reviewed'];
const OPEN_PROBLEM_STATUSES = ['summary_conflict', 'summary_no_detail', 'supplement'];

function cleanCell(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHeader(value) {
  return cleanCell(value).replace(/\s+/g, '');
}

function findHeaderRow(worksheet) {
  let best = null;
  const maxRows = Math.min(worksheet.rowCount || 0, 12);
  for (let rowNumber = 1; rowNumber <= maxRows; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = [];
    row.eachCell({ includeEmpty: true }, (cell) => headers.push(normalizeHeader(cell.text || cell.value)));
    const score =
      Number(headers.some((header) => header === '姓名' || header.endsWith('姓名'))) +
      Number(headers.some((header) => header === '学号' || header.includes('学号'))) +
      Number(headers.some((header) => header.includes('服务时长') || header.includes('志愿时长') || header.includes('总时长')));
    if (score >= 2 && (!best || score > best.score)) {
      best = { rowNumber, score };
    }
  }
  return best ? best.rowNumber : null;
}

function columnName(index) {
  let value = index;
  let text = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    text = String.fromCharCode(65 + remainder) + text;
    value = Math.floor((value - 1) / 26);
  }
  return text;
}

function getCellText(cell) {
  if (!cell) return '';
  if (cell.text !== undefined && cell.text !== null && String(cell.text).trim() !== '') {
    return cleanCell(cell.text);
  }
  if (cell.result !== undefined && cell.result !== null) return cleanCell(cell.result);
  if (cell.value && typeof cell.value === 'object') {
    if (cell.value.text) return cleanCell(cell.value.text);
    if (cell.value.result !== undefined) return cleanCell(cell.value.result);
    if (cell.value.richText) return cleanCell(cell.value.richText.map((part) => part.text || '').join(''));
  }
  return cleanCell(cell.value);
}

function sourceRoots() {
  const configured = process.env.IMPORT_SOURCE_DIRS || process.env.IMPORT_SOURCE_DIR || '';
  const roots = configured
    .split('||')
    .map((item) => item.trim())
    .filter(Boolean);
  if (roots.length === 0) roots.push(path.join(process.cwd(), 'import-sources', DATASET_NAME));
  return roots.map((root) => path.resolve(root));
}

async function safeSourcePath(fileName) {
  const cleanName = path.basename(String(fileName || ''));
  if (!cleanName || cleanName !== fileName) return null;
  for (const root of sourceRoots()) {
    const candidate = path.join(root, cleanName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next mounted public dataset directory.
    }
  }
  return path.join(sourceRoots()[0], cleanName);
}

function sourceDateTime(date, end = false) {
  return `${date}T${end ? '23:59:59' : '00:00:00'}+08:00`;
}

async function resolveActivityId(client, log, userId) {
  const activityName = String(log.activity_name || '').trim();
  if (!activityName || !log.activity_date) return null;
  const activityPeriod = String(log.activity_period || '').trim();
  const activityDate = String(log.activity_date).slice(0, 10);

  const existing = await client.query(
    `
      SELECT id
      FROM activities
      WHERE name = $1
        AND COALESCE(location, '') = $2
        AND (start_time AT TIME ZONE 'Asia/Shanghai')::date = $3::date
      ORDER BY created_at DESC, id
      LIMIT 1
    `,
    [activityName, activityPeriod, activityDate],
  );
  if (existing.rowCount > 0) return existing.rows[0].id;

  const created = await client.query(
    `
      INSERT INTO activities (name, start_time, end_time, location, org_name, description, created_by, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active'::activity_status)
      RETURNING id
    `,
    [
      activityName,
      sourceDateTime(activityDate),
      sourceDateTime(activityDate, true),
      activityPeriod || null,
      log.college || null,
      `管理员复核创建；来源：${DATASET_NAME}；原始文件：${log.source_file || '-'} / ${log.source_sheet || '-'} #${log.source_row || '-'}`,
      userId,
    ],
  );
  return created.rows[0].id;
}

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/problem-logs', { preHandler: [requireCapability('reviews:read')] }, async (request, reply) => {
    const {
      type = 'all',
      student_id,
      college,
      keyword,
      limit = 200,
      offset = 0
    } = request.query;

    const params = [];
    let where = "l.source = 'imported'";

    if (type === 'unprocessed') {
      params.push(OPEN_PROBLEM_STATUSES);
      where += ` AND l.import_detail_status = ANY($${params.length}::text[]) AND l.is_legacy_processed = false`;
    } else if (type !== 'all') {
      params.push(type);
      where += ` AND l.import_detail_status = $${params.length}`;
    } else {
      params.push(PROBLEM_STATUSES);
      where += ` AND l.import_detail_status = ANY($${params.length}::text[])`;
    }

    if (student_id) {
      params.push(student_id);
      where += ` AND l.student_id = $${params.length}`;
    }
    if (college) {
      params.push(normalizeCollegeName(college));
      where += ` AND l.college = $${params.length}`;
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      where += ` AND (l.student_name ILIKE $${params.length} OR l.activity_name ILIKE $${params.length})`;
    }
    if (request.user.role === 'college_admin' && request.user.org_name && !hasFullAccess(request.user)) {
      params.push(normalizeCollegeName(request.user.org_name));
      where += ` AND l.college = $${params.length}`;
    }

    params.push(Math.min(Number(limit) || 200, 1000));
    const limitParam = params.length;
    params.push(Math.max(Number(offset) || 0, 0));
    const offsetParam = params.length;

    const { rows } = await db.query(`
      SELECT
        l.*,
        b.filename AS batch_filename,
        b.note AS batch_note,
        b.created_at AS batch_created_at,
        COALESCE(n.note_count, 0)::int AS note_count,
        n.latest_review_at
      FROM volunteer_logs l
      LEFT JOIN import_batches b ON b.id = l.import_batch_id
      LEFT JOIN (
        SELECT log_id, COUNT(*) AS note_count, MAX(created_at) AS latest_review_at
        FROM review_notes
        GROUP BY log_id
      ) n ON n.log_id = l.id
      WHERE ${where}
      ORDER BY l.created_at DESC, l.source_row NULLS LAST
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, params);

    return rows;
  });

  fastify.get('/notes/:log_id', { preHandler: [requireCapability('reviews:read')] }, async (request, reply) => {
    const { log_id } = request.params;
    const { rows } = await db.query(
      'SELECT * FROM review_notes WHERE log_id = $1 ORDER BY created_at DESC',
      [log_id]
    );
    return rows;
  });

  fastify.get('/logs/:id/source-row', { preHandler: [requireCapability('reviews:read')] }, async (request, reply) => {
    const { id } = request.params;
    const beforeRes = await db.query('SELECT * FROM volunteer_logs WHERE id = $1', [id]);
    if (beforeRes.rows.length === 0) {
      return reply.code(404).send({ message: '记录不存在' });
    }
    const log = beforeRes.rows[0];
    if (request.user.role === 'college_admin' && request.user.org_name && !hasFullAccess(request.user)) {
      const scopedCollege = normalizeCollegeName(request.user.org_name);
      if (log.college !== scopedCollege) {
        return reply.code(403).send({ message: '只能查看本学院数据' });
      }
    }
    if (!log.source_file || !log.source_sheet || !log.source_row) {
      return reply.code(404).send({ message: '该记录没有可定位的原始 Excel 行信息' });
    }

    const filePath = await safeSourcePath(log.source_file);
    if (!filePath) return reply.code(400).send({ message: '原始文件名非法' });
    try {
      await fs.access(filePath);
    } catch {
      return reply.code(404).send({ message: `服务器未找到原始 Excel 文件：${log.source_file}` });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.getWorksheet(log.source_sheet);
    if (!worksheet) return reply.code(404).send({ message: `原始工作表不存在：${log.source_sheet}` });

    const headerRowNumber = findHeaderRow(worksheet);
    const rowNumber = Number(log.source_row);
    const rawRow = worksheet.getRow(rowNumber);
    const headerRow = headerRowNumber ? worksheet.getRow(headerRowNumber) : null;
    const maxColumn = Math.max(rawRow.cellCount || 0, headerRow?.cellCount || 0, worksheet.columnCount || 0);
    const cells = [];
    for (let index = 1; index <= maxColumn; index += 1) {
      const value = getCellText(rawRow.getCell(index));
      const header = headerRow ? getCellText(headerRow.getCell(index)) : '';
      if (value || header) {
        cells.push({ column: columnName(index), index, header, value });
      }
    }

    const nearby_rows = [];
    for (let current = Math.max(1, rowNumber - 2); current <= Math.min(worksheet.rowCount, rowNumber + 2); current += 1) {
      const row = worksheet.getRow(current);
      const values = [];
      for (let index = 1; index <= maxColumn; index += 1) {
        const value = getCellText(row.getCell(index));
        if (value) values.push({ column: columnName(index), index, value });
      }
      if (values.length > 0) nearby_rows.push({ row_number: current, is_target: current === rowNumber, values });
    }

    return {
      log,
      source: {
        dataset_name: DATASET_NAME,
        file: log.source_file,
        sheet: log.source_sheet,
        row: rowNumber,
        header_row: headerRowNumber,
      },
      cells,
      nearby_rows,
    };
  });

  fastify.patch('/logs/:id', {
    preHandler: [requireCapability('reviews:manage')],
    schema: {
      body: {
        type: 'object',
        properties: {
          activity_name: { type: 'string' },
          activity_period: { type: 'string' },
          activity_date: { type: 'string' },
          hours: { type: 'number' },
          student_id: { type: 'string' },
          student_name: { type: 'string' },
          college: { type: 'string' },
          grade: { type: 'string' },
          phone: { type: 'string' },
          source_total_hours: { type: 'number' },
          note: { type: 'string' },
          mark_processed: { type: 'boolean' },
          sync_activity: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const patch = request.body || {};

    const beforeRes = await db.query('SELECT * FROM volunteer_logs WHERE id = $1', [id]);
    if (beforeRes.rows.length === 0) {
      return reply.code(404).send({ message: '记录不存在' });
    }
    const before = beforeRes.rows[0];
    if (request.user.role === 'college_admin' && request.user.org_name && !hasFullAccess(request.user)) {
      const scopedCollege = normalizeCollegeName(request.user.org_name);
      if (before.college !== scopedCollege) {
        return reply.code(403).send({ message: '只能复核本学院数据' });
      }
    }

    const updates = [];
    const params = [];
    const changed = {};

    function setField(column, value) {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
      changed[column] = value;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'student_id')) {
      const value = String(patch.student_id || '').trim();
      if (!value) return reply.code(400).send({ message: '学号不能为空' });
      setField('student_id', value.slice(0, 32));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'student_name')) {
      const value = String(patch.student_name || '').trim();
      if (!value) return reply.code(400).send({ message: '姓名不能为空' });
      setField('student_name', value.slice(0, 64));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'activity_name')) {
      const value = String(patch.activity_name || '').trim();
      if (!value) return reply.code(400).send({ message: '活动名称不能为空' });
      setField('activity_name', value.slice(0, 256));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'activity_period')) {
      setField('activity_period', String(patch.activity_period || '').trim().slice(0, 64) || null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'activity_date')) {
      const value = String(patch.activity_date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return reply.code(400).send({ message: '活动日期必须是 YYYY-MM-DD' });
      }
      setField('activity_date', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'hours')) {
      const value = Math.round(Number(patch.hours) * 10) / 10;
      if (!Number.isFinite(value) || value <= 0 || value > 9999.9) {
        return reply.code(400).send({ message: '服务时长必须在 0 到 9999.9 之间' });
      }
      setField('hours', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'source_total_hours')) {
      const value = Math.round(Number(patch.source_total_hours) * 10) / 10;
      if (!Number.isFinite(value) || value <= 0 || value > 999999.9) {
        return reply.code(400).send({ message: '源表总时长必须大于 0' });
      }
      setField('source_total_hours', value);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'college')) {
      const value = normalizeCollegeName(patch.college);
      if (value && !isFormalCollegeName(value)) {
        return reply.code(400).send({ message: '学院不在正式名称列表' });
      }
      setField('college', value || null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'grade')) {
      setField('grade', String(patch.grade || '').trim().slice(0, 16) || null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'phone')) {
      setField('phone', String(patch.phone || '').trim().slice(0, 20) || null);
    }
    if (patch.mark_processed === true) {
      setField('is_legacy_processed', true);
      setField('import_detail_status', 'reviewed');
    }

    if (updates.length === 0 && !patch.note) {
      return reply.code(400).send({ message: '没有可保存的复核内容' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      let updated = before;
      if (updates.length > 0) {
        params.push(id);
        const updateRes = await client.query(`
          UPDATE volunteer_logs
          SET ${updates.join(', ')}
          WHERE id = $${params.length}
          RETURNING *
        `, params);
        updated = updateRes.rows[0];
      }

      const shouldSyncActivity = patch.sync_activity !== false && (
        Object.prototype.hasOwnProperty.call(changed, 'activity_name') ||
        Object.prototype.hasOwnProperty.call(changed, 'activity_period') ||
        Object.prototype.hasOwnProperty.call(changed, 'activity_date') ||
        !updated.activity_id
      );
      if (shouldSyncActivity) {
        const activityId = await resolveActivityId(client, updated, request.user.id);
        if (activityId) {
          const linked = await client.query(
            'UPDATE volunteer_logs SET activity_id = $1 WHERE id = $2 RETURNING *',
            [activityId, id],
          );
          updated = linked.rows[0];
          changed.activity_id = activityId;
        }
      }

      await client.query(`
        INSERT INTO review_notes (log_id, user_id, username, action, detail)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        id,
        request.user.id,
        request.user.real_name || request.user.username,
        patch.mark_processed === true ? 'confirm_processed' : 'update',
        {
          note: String(patch.note || '').trim(),
          changed,
          before: {
            activity_name: before.activity_name,
            activity_period: before.activity_period,
            activity_date: before.activity_date,
            hours: before.hours,
            student_id: before.student_id,
            student_name: before.student_name,
            college: before.college,
            grade: before.grade,
            phone: before.phone,
            source_total_hours: before.source_total_hours,
            import_detail_status: before.import_detail_status,
            is_legacy_processed: before.is_legacy_processed
          }
        }
      ]);

      await client.query('COMMIT');
      await writeAudit(request, 'reviews.update_log', 'volunteer_log', id, {
        changed,
        mark_processed: patch.mark_processed === true
      });
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error({ err }, 'review update failed');
      return reply.code(500).send({ message: '复核保存失败' });
    } finally {
      client.release();
    }
  });
};
