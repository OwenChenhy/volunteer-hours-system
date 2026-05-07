const ExcelJS = require('exceljs');
const db = require('../db');
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
        grade: normalizeCell(rowData.grade),
        activity_name: normalizeCell(rowData.activity_name),
        activity_date: normalizeDate(rowData.activity_date),
        hours: parseHours(rowData.hours),
        phone: normalizeCell(rowData.phone),
        status: 'ok',
        message: '',
        issues: [],
        can_import: true,
        requires_confirmation: false
      };

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

      if (previewRow.hours === null || previewRow.hours <= 0) {
        addIssue(previewRow, 'invalid_hours', 'error', '服务时长必须大于 0');
      } else if (previewRow.hours > 9999.9) {
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
          previewRow.activity_date
        );
        if (isDuplicate) {
          addIssue(previewRow, 'duplicate_record', 'warning', '该学生已存在相同活动和日期的已通过记录');
        }
      }

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
  const seenInRequest = new Set();

  for (const row of rows) {
    const { record, problemIssues } = await prepareImportRow(row, options);
    const duplicateKey = makeDuplicateKey(record);
    if (duplicateKey && seenInRequest.has(duplicateKey)) {
      if (row.problem_confirmed !== true) {
        throw importValidationError(`第 ${row.row || '?'} 行与本次导入中其他记录重复，需管理员确认后才能导入`);
      }
      problemIssues.push('duplicate_in_request');
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

    let replacedBatchCount = 0;
    let replacedRecordCount = 0;
    if (options.replace_existing_note === true) {
      const normalizedNote = normalizeCell(note);
      if (!normalizedNote) {
        throw importValidationError('安全重导必须填写批次备注，并且只能替换备注完全一致的历史批次');
      }
      const existingRes = await client.query(
        'SELECT id FROM import_batches WHERE note = $1 ORDER BY created_at DESC',
        [normalizedNote]
      );
      const existingIds = existingRes.rows.map((row) => row.id);
      replacedBatchCount = existingIds.length;
      if (existingIds.length > 0) {
        const deleteLogs = await client.query(
          'DELETE FROM volunteer_logs WHERE import_batch_id = ANY($1::uuid[])',
          [existingIds]
        );
        replacedRecordCount = deleteLogs.rowCount || 0;
        await client.query('DELETE FROM import_batches WHERE id = ANY($1::uuid[])', [existingIds]);
      }
    }

    // 1. 创建导入批次
    const batchQuery = `
      INSERT INTO import_batches (filename, imported_by, record_count, note)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const batchRes = await client.query(batchQuery, [
      filename,
      userId,
      importableRows.length,
      note
    ]);
    const batchId = batchRes.rows[0].id;

    // 2. 批量插入记录
    // 注意：导入的数据状态为 'approved' 且来源为 'imported'
    for (const row of importableRows) {
      const logQuery = `
        INSERT INTO volunteer_logs (
          student_id, student_name, college, grade, phone, activity_name, activity_date,
          hours, source, status, import_batch_id, is_legacy_processed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'imported', 'approved', $9, false)
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
        batchId
      ]);
    }

    await client.query('COMMIT');
    return {
      success: true,
      batch_id: batchId,
      count: importableRows.length,
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
    phone: get('联系方式', '联系电话', '手机号')
  };
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
  const issueCounts = new Map();
  let totalHours = 0;
  let importableHours = 0;
  let unknownCollegeRows = 0;
  let largeHourRows = 0;

  for (const row of rows) {
    const college = row.college || '未填写';
    const hours = Number(row.hours || 0);
    if (Number.isFinite(hours) && hours > 0) {
      totalHours += hours;
      if (row.can_import) importableHours += hours;
    }
    byCollege.set(college, (byCollege.get(college) || 0) + 1);
    if (hasIssue(row, 'unknown_college')) unknownCollegeRows++;
    if (hasIssue(row, 'large_hours')) largeHourRows++;
    for (const issue of row.issues || []) {
      issueCounts.set(issue.code, (issueCounts.get(issue.code) || 0) + 1);
    }
  }

  return {
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
    grade: normalizeCell(row.grade),
    phone: normalizeCell(row.phone),
    activity_name: normalizeCell(row.activity_name),
    activity_date: normalizeDate(row.activity_date),
    hours: parseHours(row.hours)
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
  if (record.hours === null || record.hours <= 0) {
    throw importValidationError(`第 ${rowNumber} 行服务时长必须大于 0`);
  }
  if (record.hours > 9999.9) {
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

  if (await checkDuplicateRecord(record.student_id, record.activity_name, record.activity_date)) {
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
  return [row.student_id, row.activity_name, row.activity_date].join('\u0000');
}

// 辅助函数：校验日期
function isValidDate(dateInput) {
  const text = normalizeDate(dateInput);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

// 辅助函数：检查是否重复
async function checkDuplicateRecord(studentId, activityName, activityDate) {
  const query = `
    SELECT 1 FROM volunteer_logs
    WHERE student_id = $1 AND activity_name = $2 AND activity_date = $3 AND status = 'approved'
    LIMIT 1
  `;
  const { rows } = await db.query(query, [studentId, activityName, activityDate]);
  return rows.length > 0;
}

module.exports = {
  parsePreview,
  confirmImport
};
