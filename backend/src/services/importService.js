const ExcelJS = require('exceljs');
const db = require('../db');
const academic = require('./academicService');
const { normalizeCollegeName, isFormalCollegeName } = require('../utils/collegeNames');

/**
 * 解析 Excel 文件并返回预览数据
 * @param {Buffer} buffer - Excel 文件内容
 * @returns {Promise<object>} 返回预览结果
 */
const parsePreview = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const previewRows = [];
  const seenInFile = new Set();
  let totalCount = 0;
  let validCount = 0;
  let okCount = 0;
  let warningCount = 0;
  let errorCount = 0;

  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const matrix = worksheetToMatrix(worksheet);
    const rows = normalizeRows(matrix);
    totalCount += rows.length;

    for (let index = 0; index < rows.length; index++) {
      const rowData = rows[index];
      const rowNumber = rowData._row_number || index + 2;
      const previewRow = {
        sheet: sheetName,
        row: rowNumber,
        student_id: normalizeCell(rowData.student_id),
        student_name: normalizeCell(rowData.student_name),
        college: normalizeCollegeName(rowData.college),
        grade: normalizeCell(rowData.grade) || normalizeCell(sheetName.match(/(?:20)?\d{2}级/)?.[0]),
        activity_name: normalizeCell(rowData.activity_name),
        activity_date: normalizeDate(rowData.activity_date),
        hours: parseHours(rowData.hours),
        year_inferred: !normalizeCell(rowData.academic_year),
        term_inferred: !normalizeCell(rowData.academic_term),
        activity_period: normalizeCell(rowData.activity_period),
        academic_year: normalizeCell(rowData.academic_year),
        academic_term: normalizeTerm(rowData.academic_term),
        is_adjustment: /调整|扣减|补录更正/.test(String(rowData.record_type || '')) || Boolean(rowData.is_adjustment),
        adjustment_reason: normalizeCell(rowData.adjustment_reason),
        is_cumulative: Boolean(rowData.is_cumulative),
        phone: normalizeCell(rowData.phone),
        status: 'ok',
        message: '',
        issues: [],
        can_import: true,
        requires_confirmation: false
      };

      if (/扣减/.test(String(rowData.record_type || '')) && previewRow.hours !== null) previewRow.hours = -Math.abs(previewRow.hours);
      if (!previewRow.grade && previewRow.student_id && previewRow.student_name) {
        const known = await db.query('SELECT DISTINCT grade FROM volunteer_logs WHERE student_id = $1 AND student_name = $2 AND grade IS NOT NULL AND grade <> $3', [previewRow.student_id, previewRow.student_name, '']);
        if (known.rows.length === 1) previewRow.grade = known.rows[0].grade;
      }
      if (!previewRow.grade) addIssue(previewRow, 'missing_grade', 'warning', '缺少年级，请提供默认年级或确认暂未分类');
      if (previewRow.academic_year && !academic.validYear(previewRow.academic_year)) addIssue(previewRow, 'invalid_academic_year', 'error', '学年必须为连续两年，例如2025-2026');
      if (rowData.academic_term && !previewRow.academic_term) addIssue(previewRow, 'invalid_academic_term', 'error', '阶段须为上半年、下半年或寒暑假补录');
      if (previewRow.is_adjustment && !previewRow.adjustment_reason) addIssue(previewRow, 'missing_adjustment_reason', 'error', '调整记录必须填写调整说明');
      if (previewRow.is_cumulative) addIssue(previewRow, 'cumulative_table', 'warning', '本表为累计数据，请用同一批次备注替换旧累计表，不能直接叠加');
      if (!previewRow.student_id || !previewRow.student_name) {
        addIssue(previewRow, 'missing_identity', 'error', '学号或姓名不能为空');
      }

      if (previewRow.student_id.length > 32) {
        addIssue(previewRow, 'student_id_too_long', 'error', '学号超过 32 个字符，需先修正原始数据');
      }

      if (previewRow.student_name.length > 64) {
        addIssue(previewRow, 'student_name_too_long', 'error', '姓名超过 64 个字符，需先修正原始数据');
      }

      if (!previewRow.activity_name) {
        addIssue(previewRow, 'missing_activity_name', 'warning', '活动名称为空，需填写默认活动名称并确认');
      }

      if (previewRow.activity_name.length > 256) {
        addIssue(previewRow, 'activity_name_too_long', 'warning', '活动名称超过 256 个字符，确认后将截断导入');
      }

      if (previewRow.college.length > 128) {
        addIssue(previewRow, 'college_too_long', 'warning', '学院超过 128 个字符，确认后将截断导入');
      }

      if (previewRow.college && !isFormalCollegeName(previewRow.college)) {
        addIssue(previewRow, 'unknown_college', 'error', '学院不在正式名称列表，请先修正原始数据');
      }

      if (previewRow.grade.length > 16) {
        addIssue(previewRow, 'grade_too_long', 'warning', '年级超过 16 个字符，确认后将截断导入');
      }

      if (previewRow.phone.length > 20) {
        addIssue(previewRow, 'phone_too_long', 'warning', '联系方式超过 20 个字符，确认后将截断导入');
      }

      if (previewRow.hours === null || (previewRow.hours < 0 && !previewRow.is_adjustment) || (previewRow.hours === 0 && !previewRow.is_adjustment && !previewRow.is_cumulative)) {
        addIssue(previewRow, 'invalid_hours', 'error', '普通服务时长必须大于0，扣减需选择调整并填写说明');
      } else if (Math.abs(previewRow.hours) > 9999.9) {
        addIssue(previewRow, 'hours_too_large', 'error', '服务时长超过系统上限 9999.9');
      } else if (previewRow.hours > 200) {
        addIssue(previewRow, 'large_hours', 'warning', '服务时长超过 200 小时，请管理员确认');
      }

      if (!previewRow.activity_date || !isValidDate(previewRow.activity_date)) {
        addIssue(previewRow, 'missing_or_invalid_activity_date', 'warning', '活动日期缺失或无效，需填写默认日期并确认');
      }

      const duplicateKey = makeDuplicateKey(previewRow);
      if (duplicateKey && seenInFile.has(duplicateKey)) {
        addIssue(previewRow, 'duplicate_in_file', 'warning', '本次导入文件内存在相同学生、活动和日期的重复记录');
      } else if (duplicateKey) {
        seenInFile.add(duplicateKey);
      }

      const hasHardError = previewRow.issues.some((issue) => issue.level === 'error');
      if (!hasHardError && previewRow.activity_name && isValidDate(previewRow.activity_date)) {
        const isDuplicate = await checkDuplicateRecord(
          previewRow.student_id,
          previewRow.activity_name,
          previewRow.activity_date, previewRow.is_adjustment, previewRow.hours, previewRow.adjustment_reason
        );
        if (isDuplicate) {
          addIssue(previewRow, 'duplicate_record', 'warning', '该学生已存在相同活动和日期的待审核、已通过或已驳回记录');
        }
      }

      if (previewRow.is_cumulative && previewRow.term_inferred && !previewRow.activity_period) previewRow.academic_term = 'unassigned';
      const category = academic.classify(previewRow);
      previewRow.academic_year = category.academic_year;
      previewRow.academic_term = category.academic_term;
      previewRow.term_label = category.term_label;
      finalizePreviewRow(previewRow);
      if (previewRow.status === 'error') {
        errorCount++;
      } else if (previewRow.status === 'warning') {
        warningCount++;
        validCount++;
      } else {
        okCount++;
        validCount++;
      }

      previewRows.push(previewRow);
    }
  }

  return {
    total: totalCount,
    valid: validCount,
    ok: okCount,
    warnings: warningCount,
    errors: errorCount,
    diff_report: buildDiffReport(previewRows),
    rows: previewRows
  };
};

/**
 * 将解析后的数据正式存入数据库
 * @param {Array} rows - 解析并通过初步校验的数据行
 * @param {string} userId - 导入人 ID
 * @param {string} note - 导入批次备注
 */
const confirmImport = async (rows, userId, note, filename = 'imported_file.xlsx', options = {}) => {
  const importableRows = [];
  let confirmedProblemCount = 0;
  let skippedDuplicateCount = 0;
  const seenInRequest = new Set();

  for (const row of rows) {
    const { record, problemIssues } = await prepareImportRow(row, { ...options, note });
    const duplicateKey = makeDuplicateKey(record);
    if (duplicateKey && seenInRequest.has(duplicateKey)) {
      skippedDuplicateCount++;
      continue;
    } else if (duplicateKey) {
      seenInRequest.add(duplicateKey);
    }
    if (problemIssues.length > 0) confirmedProblemCount++;
    importableRows.push(record);
  }

  if (importableRows.length === 0) {
    throw importValidationError('没有可导入的有效记录');
  }

  const client = await db.pool.connect();
  try {
await client.query('BEGIN');
    // ponytail: one transaction lock serializes school imports; use per-dataset locks if concurrent import volume grows.
    await client.query('SELECT pg_advisory_xact_lock(927641)');
    if (options.expected_revision !== undefined) {
      await client.query('LOCK TABLE volunteer_logs IN SHARE ROW EXCLUSIVE MODE');
      const revision = (await client.query('SELECT revision FROM data_versions WHERE id=true')).rows[0].revision;
      if (String(revision) !== String(options.expected_revision)) throw importValidationError('审核库已有变更，请重新核对导入摘要');
    }
    if (options.file_hash && options.replace_existing_note !== true && options.replace_dataset !== true) {
      const existingFile = await client.query('SELECT id, record_count FROM import_batches WHERE file_hash = $1 AND superseded_at IS NULL', [options.file_hash]);
      if (existingFile.rows.length) {
        await client.query('ROLLBACK');
        return { success: true, count: 0, batch_id: existingFile.rows[0].id, skipped_duplicate_count: rows.length, already_imported: true, confirmed_problem_count: 0, replaced_batch_count: 0, replaced_record_count: 0 };
      }
    }

    let replacedBatchCount = 0;
    let replacedRecordCount = 0;
    if (options.dataset_key) {
      const prior = await client.query('SELECT id FROM import_batches WHERE dataset_key=$1 AND superseded_at IS NULL ORDER BY created_at DESC', [options.dataset_key]);
      const ids = prior.rows.map(row => row.id);
      if (ids.length && options.replace_dataset !== true) throw importValidationError('时长库已存在，请选择更新已有库并重新核对摘要');
      replacedBatchCount = ids.length;
      if (ids.length) {
        const retired = await client.query(`UPDATE volunteer_logs SET lifecycle_previous_status=status::text,status='voided',
          lifecycle_reason='累计时长库更新替换',lifecycle_at=now(),lifecycle_by=$2
          WHERE import_batch_id=ANY($1::uuid[]) AND status IN ('pending','approved','rejected') RETURNING id`, [ids,userId]);
        replacedRecordCount = retired.rowCount;
        await client.query('UPDATE import_batches SET superseded_at=now() WHERE id=ANY($1::uuid[])', [ids]);
      }
    } else if (options.replace_existing_note === true) {
      const normalizedNote = normalizeCell(note);
      if (!normalizedNote) {
        throw importValidationError('安全重导必须填写批次备注，并且只能替换备注完全一致的历史批次');
      }
      const existingRes = await client.query(
        'SELECT id FROM import_batches WHERE note = $1 AND superseded_at IS NULL ORDER BY created_at DESC',
        [normalizedNote]
      );
      const existingIds = existingRes.rows.map((row) => row.id);
      replacedBatchCount = existingIds.length;
      if (existingIds.length > 0) {
        const deleteLogs = await client.query(
          `UPDATE volunteer_logs SET lifecycle_previous_status=status::text,status='voided',lifecycle_reason='累计时长库更新替换',lifecycle_at=now(),lifecycle_by=$2 WHERE import_batch_id=ANY($1::uuid[]) AND status IN ('pending','approved','rejected')`,
          [existingIds,userId]
        );
        replacedRecordCount = deleteLogs.rowCount || 0;
        await client.query('UPDATE import_batches SET superseded_at=now() WHERE id=ANY($1::uuid[])', [existingIds]);
      }
    }

const uniqueRows = [];
    for (const row of importableRows) {
      if (await checkDuplicateRecord(row.student_id, row.activity_name, row.activity_date, row.is_adjustment, row.hours, row.adjustment_reason, client)) skippedDuplicateCount++;
      else uniqueRows.push(row);
    }
    if (!uniqueRows.length) {
      await client.query('ROLLBACK');
      return { success: true, batch_id: null, count: 0, skipped_duplicate_count: skippedDuplicateCount, confirmed_problem_count: confirmedProblemCount, replaced_batch_count: 0, replaced_record_count: 0 };
    }

    // 1. 创建导入批次
    const batchQuery = `
      INSERT INTO import_batches (filename, imported_by, record_count, note, file_hash)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    const batchRes = await client.query(batchQuery, [
      filename,
      userId,
      uniqueRows.length,
      note,
      options.file_hash || null
    ]);
    const batchId = batchRes.rows[0].id;
    if (options.dataset_key) await client.query('UPDATE import_batches SET dataset_key=$2 WHERE id=$1', [batchId,options.dataset_key]);

    // 2. 批量插入记录
    // 注意：导入的数据状态为 'approved' 且来源为 'imported'
    for (const row of uniqueRows) {
      const logQuery = `
        INSERT INTO volunteer_logs (
          student_id, student_name, college, grade, phone, activity_name, activity_date,
          hours, source, status, import_batch_id, is_legacy_processed,
          academic_year, academic_term, is_adjustment, adjustment_reason, activity_period
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'imported', 'approved', $9, false, $10, $11, $12, $13, $14)
      `;
      await client.query(logQuery, [
        row.student_id,
        row.student_name,
        row.college,
        row.grade,
        row.phone,
        row.activity_name,
        row.activity_date,
        row.hours,
        batchId,
        row.academic_year,
        row.academic_term,
        row.is_adjustment,
        row.adjustment_reason || null,
        row.activity_period || null
      ]);
    }

    await client.query('COMMIT');
    return {
      success: true,
      batch_id: batchId,
      count: uniqueRows.length,
      skipped_duplicate_count: skippedDuplicateCount,
      confirmed_problem_count: confirmedProblemCount,
      replaced_batch_count: replacedBatchCount,
      replaced_record_count: replacedRecordCount
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

function normalizeRows(matrix) {
  if (matrix.length < 2) return [];

  const headerIndex = findHeaderRow(matrix);
  if (headerIndex < 0) return [];

  const headers = matrix[headerIndex].map((value) => String(value).trim());
  const hasChineseHeaders = headers.some((header) => ['学号', '姓名', '服务时长（小时）', '服务时长'].includes(header));
  const rows = [];

  for (let rowIndex = headerIndex + 1; rowIndex < matrix.length; rowIndex++) {
    const row = matrix[rowIndex];
    if (!row.some((cell) => String(cell).trim() !== '')) continue;
    const mapped = hasChineseHeaders
      ? mapByHeaders(headers, row)
      : {
          student_id: row[0],
          student_name: row[1],
          college: row[2],
          grade: row[3],
          activity_name: row[4],
          activity_date: row[5],
          hours: row[6],
          phone: row[7]
        };
    mapped._row_number = rowIndex + 1;
    rows.push(mapped);
  }

  return rows;
}

function worksheetToMatrix(worksheet) {
  const matrix = [];
  const rowCount = worksheet.rowCount || 0;
  const columnCount = Math.max(worksheet.columnCount || 0, 8);

  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex++) {
    const row = worksheet.getRow(rowIndex);
    const values = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex++) {
      values.push(cellToValue(row.getCell(columnIndex)));
    }
    matrix.push(values);
  }

  return matrix;
}

function cellToValue(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return value;
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return value.result;
  if (value.text) return value.text;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  if (value.hyperlink && value.text) return value.text;
  return String(value);
}

function findHeaderRow(matrix) {
  let best = { index: -1, score: 0 };
  for (let rowIndex = 0; rowIndex < Math.min(matrix.length, 12); rowIndex++) {
    const headers = matrix[rowIndex].map((value) => normalizeCell(value).replace(/\s+/g, ''));
    const score =
      Number(headers.some((header) => header === '学号' || header.includes('学号'))) +
      Number(headers.some((header) => header === '姓名' || header.endsWith('姓名'))) +
      Number(headers.some((header) => header.includes('服务时长') || header.includes('志愿时长') || header === '时长')) +
      Number(headers.some((header) => header.includes('活动')));

    if (score > best.score) {
      best = { index: rowIndex, score };
    }
  }

  return best.score >= 2 ? best.index : -1;
}

function mapByHeaders(headers, row) {
  const get = (...names) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index >= 0 ? row[index] : '';
  };
  const activityColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => header.includes('活动') && !header.includes('日期') && !header.includes('时间'));
  const activityName = activityColumns
    .map(({ index }) => String(row[index] || '').trim())
    .filter(Boolean)
    .join('；');

  return {
    student_id: get('学号'),
    student_name: get('姓名'),
    college: get('学院'),
    grade: get('年级'),
    activity_name: get('活动名称') || activityName,
    activity_date: get('活动日期', '活动时间', '开展时间'),
    hours: get('服务时长（小时）', '服务时长', '时长', '累计服务时长'),
    phone: get('联系方式', '联系电话', '手机号'),
    academic_year: get('学年'),
    academic_term: get('归属阶段', '学期', '阶段'),
    activity_period: get('活动期间', '时间说明'),
    record_type: get('录入类型', '记录类型'),
    adjustment_reason: get('调整说明', '修改原因'),
    is_cumulative: headers.some((header) => /累计.*时长/.test(header))
  };
}

function normalizeTerm(value) {
  const text = normalizeCell(value);
  if (Object.prototype.hasOwnProperty.call(academic.TERM_LABELS, text)) return text;
  if (/寒假|暑假|寒暑假|暑期|寒期/.test(text)) return 'vacation';
  if (/上半年|上学期|秋季/.test(text)) return 'upper';
  if (/下半年|下学期|春季/.test(text)) return 'lower';
  return null;
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseHours(value) {
  const text = normalizeCell(value).replace(/[，,]/g, '').replace(/小时/g, '').replace(/h$/i, '');
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const hours = Number(match[0]);
  if (!Number.isFinite(hours)) return null;
  return Math.round(hours * 10) / 10;
}

function addIssue(row, code, level, message) {
  row.issues.push({ code, level, message });
}

function finalizePreviewRow(row) {
  const hasError = row.issues.some((issue) => issue.level === 'error');
  const hasWarning = row.issues.some((issue) => issue.level === 'warning');

  row.status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  row.can_import = !hasError;
  row.requires_confirmation = !hasError && hasWarning;
  row.message = row.issues.map((issue) => issue.message).join('；');
}

function buildDiffReport(rows) {
  const byCollege = new Map();
  const byGrade = new Map();
  const byTerm = new Map();
  const issueCounts = new Map();
  let totalHours = 0;
  let importableHours = 0;
  let unknownCollegeRows = 0;
  let largeHourRows = 0;

  for (const row of rows) {
    const college = row.college || '未填写';
    const hours = Number(row.hours || 0);
    if (Number.isFinite(hours)) {
      totalHours += hours;
      if (row.can_import) importableHours += hours;
    }
    byCollege.set(college, (byCollege.get(college) || 0) + 1);
    byGrade.set(row.grade || '待确认年级', (byGrade.get(row.grade || '待确认年级') || 0) + 1);
    byTerm.set(row.term_label || '待确认', (byTerm.get(row.term_label || '待确认') || 0) + 1);
    if (hasIssue(row, 'unknown_college')) unknownCollegeRows++;
    if (hasIssue(row, 'large_hours')) largeHourRows++;
    for (const issue of row.issues || []) {
      issueCounts.set(issue.code, (issueCounts.get(issue.code) || 0) + 1);
    }
  }

  return {
    by_grade: [...byGrade].map(([grade, count]) => ({ grade, count })),
    by_term: [...byTerm].map(([term, count]) => ({ term, count })),
    total_rows: rows.length,
    importable_rows: rows.filter((row) => row.can_import).length,
    error_rows: rows.filter((row) => row.status === 'error').length,
    warning_rows: rows.filter((row) => row.status === 'warning').length,
    total_hours: Math.round(totalHours * 10) / 10,
    importable_hours: Math.round(importableHours * 10) / 10,
    unknown_college_rows: unknownCollegeRows,
    large_hour_rows: largeHourRows,
    issue_counts: Object.fromEntries([...issueCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    by_college: [...byCollege.entries()]
      .map(([college, count]) => ({ college, count }))
      .sort((a, b) => b.count - a.count || a.college.localeCompare(b.college, 'zh-Hans-CN'))
  };
}

function hasIssue(row, code) {
  return Array.isArray(row?.issues) && row.issues.some((issue) => issue.code === code);
}

async function prepareImportRow(row, options) {
  if (!row || row.status === 'error' || row.can_import === false) {
    throw importValidationError(`第 ${row?.row || '?'} 行存在不可导入错误，请先修正原始数据`);
  }

  const rowNumber = row.row || '?';
  const problemIssues = [];
  const record = {
    student_id: normalizeCell(row.student_id),
    student_name: normalizeCell(row.student_name),
    college: normalizeCollegeName(row.college),
    grade: normalizeCell(row.grade || options.default_grade),
    phone: normalizeCell(row.phone),
    activity_name: normalizeCell(row.activity_name),
    activity_date: normalizeDate(row.activity_date),
    hours: parseHours(row.hours),
    academic_year: normalizeCell(options.default_academic_year || (row.year_inferred ? null : row.academic_year)),
    academic_term: normalizeTerm(options.default_academic_term || (row.term_inferred && !row.is_cumulative ? null : row.academic_term)),
    activity_period: normalizeCell(row.activity_period),
    is_adjustment: row.is_adjustment === true,
    adjustment_reason: normalizeCell(row.adjustment_reason)
  };

  if (!record.student_id || !record.student_name) {
    throw importValidationError(`第 ${rowNumber} 行学号或姓名不能为空`);
  }
  if (record.student_id.length > 32) {
    throw importValidationError(`第 ${rowNumber} 行学号超过 32 个字符`);
  }
  if (record.student_name.length > 64) {
    throw importValidationError(`第 ${rowNumber} 行姓名超过 64 个字符`);
  }
  if (record.college && !isFormalCollegeName(record.college)) {
    throw importValidationError(`第 ${rowNumber} 行学院不在正式名称列表，请先修正原始数据`);
  }
  if (record.hours === null || (record.hours < 0 && !record.is_adjustment) || (record.hours === 0 && !record.is_adjustment && !row.is_cumulative)) {
    throw importValidationError(`第 ${rowNumber} 行普通服务时长必须大于0，扣减须为调整记录`);
  }
  if (record.is_adjustment && !record.adjustment_reason) throw importValidationError(`第 ${rowNumber} 行调整说明不能为空`);
  if (record.academic_year && !academic.validYear(record.academic_year)) throw importValidationError(`第 ${rowNumber} 行学年无效`);
  if (row.is_cumulative && !options.dataset_key && (!options.replace_existing_note || !normalizeCell(options.note))) throw importValidationError('累计表必须使用固定批次备注替换旧表，请选择安全重导');
  if (Math.abs(record.hours) > 9999.9) {
    throw importValidationError(`第 ${rowNumber} 行服务时长超过系统上限 9999.9`);
  }

  if (!record.activity_name) {
    const fallbackName = normalizeCell(options.default_activity_name);
    if (!fallbackName) {
      throw importValidationError(`第 ${rowNumber} 行缺少活动名称，请填写默认活动名称并确认`);
    }
    record.activity_name = fallbackName;
    problemIssues.push('missing_activity_name');
  }

  if (!record.activity_date || !isValidDate(record.activity_date)) {
    const fallbackDate = normalizeDate(options.default_activity_date);
    if (!fallbackDate || !isValidDate(fallbackDate)) {
      throw importValidationError(`第 ${rowNumber} 行缺少有效活动日期，请填写默认日期并确认`);
    }
    record.activity_date = fallbackDate;
    problemIssues.push('missing_or_invalid_activity_date');
  }

  if (record.activity_name.length > 256) {
    record.activity_name = truncate(record.activity_name, 256);
    problemIssues.push('activity_name_too_long');
  }
  if (record.college.length > 128) {
    record.college = truncate(record.college, 128);
    problemIssues.push('college_too_long');
  }
  if (record.grade.length > 16) {
    record.grade = truncate(record.grade, 16);
    problemIssues.push('grade_too_long');
  }
  if (record.phone.length > 20) {
    record.phone = truncate(record.phone, 20);
    problemIssues.push('phone_too_long');
  }
  if (record.hours > 200) {
    problemIssues.push('large_hours');
  }

  Object.assign(record, academic.classify(record));
  if (await checkDuplicateRecord(record.student_id, record.activity_name, record.activity_date, record.is_adjustment, record.hours, record.adjustment_reason)) {
    problemIssues.push('duplicate_record');
  }

  if (row.status === 'warning' || row.requires_confirmation || problemIssues.length > 0) {
    if (row.problem_confirmed !== true) {
      throw importValidationError(`第 ${rowNumber} 行存在问题数据，需管理员勾选确认后才能导入`);
    }
  }

  return { record, problemIssues: [...new Set(problemIssues)] };
}

function importValidationError(message) {
  const error = new Error(message);
  error.code = 'IMPORT_VALIDATION';
  return error;
}

function truncate(value, maxLength) {
  const text = normalizeCell(value);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function normalizeDate(value) {
  if (value instanceof Date) {
    return [
      String(value.getFullYear()).padStart(4, '0'),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0')
    ].join('-');
  }

  if (typeof value === 'number') {
    return excelSerialDateToIso(value);
  }

  const text = String(value || '').trim();
  const match = text.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function excelSerialDateToIso(serial) {
  const base = Date.UTC(1899, 11, 30);
  const date = new Date(base + Number(serial) * 24 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return String(serial);
  return date.toISOString().slice(0, 10);
}

function makeDuplicateKey(row) {
  if (!row.student_id || !row.activity_name || !isValidDate(row.activity_date)) return '';
  return [row.student_id, row.activity_name, row.activity_date, row.is_adjustment ? `${row.hours}:${row.adjustment_reason}` : 'normal'].join('\u0000');
}

// 辅助函数：校验日期
function isValidDate(dateInput) {
  const text = normalizeDate(dateInput);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

// 辅助函数：检查是否重复
async function checkDuplicateRecord(studentId, activityName, activityDate, adjustment = false, hours = 0, reason = '', executor = db) {
  const query = `
    SELECT 1 FROM volunteer_logs
    WHERE student_id = $1 AND activity_name = $2 AND activity_date = $3 AND status IN ('pending','approved','rejected')
      AND is_adjustment = $4 AND ($4 = false OR (hours = $5 AND adjustment_reason = $6))
    LIMIT 1
  `;
  const { rows } = await executor.query(query, [studentId, activityName, activityDate, adjustment, hours, reason]);
  return rows.length > 0;
}

module.exports = {
  parsePreview,
  prepareImportRow,
  makeDuplicateKey,
  confirmImport
};
