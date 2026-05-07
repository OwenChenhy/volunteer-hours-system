const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { normalizeCollegeName } = require('../backend/src/utils/collegeNames');

const DATASET_NAME = '2025-2026志愿者时长库3月公示';
const ACTIVITY_DATE = process.env.MARCH_PUBLIC_ACTIVITY_DATE || '2026-03-31';
const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '..', DATASET_NAME);
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', 'import-output');

const sourceDir = path.resolve(process.argv[2] || DEFAULT_SOURCE_DIR);
const outputDir = path.resolve(process.argv[3] || DEFAULT_OUTPUT_DIR);

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeHeader(value) {
  return normalizeCell(value).replace(/\s+/g, '');
}

function parseHours(value) {
  const text = normalizeCell(value)
    .replace(/[，,]/g, '')
    .replace(/小时/g, '')
    .replace(/h$/i, '');
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 10) / 10;
}

function findHeaderRow(rows) {
  let best = null;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 12); rowIndex += 1) {
    const row = rows[rowIndex].map(normalizeHeader);
    const score =
      Number(row.some((h) => h === '姓名' || h.endsWith('姓名'))) +
      Number(row.some((h) => h === '学号' || h.includes('学号'))) +
      Number(row.some((h) => h.includes('服务时长') || h.includes('志愿时长') || h.includes('总时长')));

    if (score >= 2 && (!best || score > best.score)) {
      best = { rowIndex, score };
    }
  }
  return best ? best.rowIndex : -1;
}

function findColumns(headerRow) {
  const columns = {};
  const activityColumns = [];

  headerRow.forEach((rawHeader, index) => {
    const header = normalizeHeader(rawHeader);
    if (!header) return;

    if (columns.student_name === undefined && (header === '姓名' || header.endsWith('姓名'))) {
      columns.student_name = index;
    } else if (columns.college === undefined && header === '学院') {
      columns.college = index;
    } else if (columns.grade === undefined && header === '年级') {
      columns.grade = index;
    } else if (columns.student_id === undefined && (header === '学号' || header.includes('学号'))) {
      columns.student_id = index;
    } else if (
      columns.phone === undefined &&
      (header.includes('联系方式') || header === '电话' || header.includes('手机号'))
    ) {
      columns.phone = index;
    } else if (
      columns.hours === undefined &&
      (header.includes('服务时长') || header.includes('志愿时长') || header.includes('总时长'))
    ) {
      columns.hours = index;
    }

    const isActivity =
      (header.includes('活动') || header.includes('补录') || header.includes('寒暑')) &&
      !header.includes('服务时长') &&
      !header.includes('志愿时长');
    if (isActivity) activityColumns.push(index);
  });

  columns.activityColumns = [...new Set(activityColumns)];
  return columns;
}

function isUsableColumnSet(columns) {
  return (
    columns.student_name !== undefined &&
    columns.student_id !== undefined &&
    columns.hours !== undefined
  );
}

function truncate(value, maxLength) {
  const text = normalizeCell(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function makeActivityName(record) {
  const scope = [record.college, record.grade].filter(Boolean).join('/');
  const suffix = scope ? `（${scope}）` : '';
  return truncate(`${DATASET_NAME}累计时长${suffix}`, 256);
}

function readWorkbookRecords(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const fileName = path.basename(filePath);
  const records = [];
  const invalidRows = [];
  const sheetSummaries = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false,
    });

    if (rows.length === 0) {
      sheetSummaries.push({ sheet: sheetName, rows: 0, imported: 0, skipped: 0, reason: 'empty' });
      continue;
    }

    const headerIndex = findHeaderRow(rows);
    if (headerIndex < 0) {
      sheetSummaries.push({ sheet: sheetName, rows: rows.length, imported: 0, skipped: rows.length, reason: 'header_not_found' });
      continue;
    }

    const columns = findColumns(rows[headerIndex]);
    if (!isUsableColumnSet(columns)) {
      sheetSummaries.push({ sheet: sheetName, rows: rows.length, imported: 0, skipped: rows.length, reason: 'required_columns_missing' });
      continue;
    }

    let imported = 0;
    let skipped = 0;
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const studentName = normalizeCell(row[columns.student_name]);
      const studentId = normalizeCell(row[columns.student_id]);
      const hours = parseHours(row[columns.hours]);

      const hasAnyData = row.some((cell) => normalizeCell(cell));
      if (!hasAnyData) {
        skipped += 1;
        continue;
      }

      if (!studentName || !studentId || hours === null) {
        const reason = [];
        if (!studentName) reason.push('missing_student_name');
        if (!studentId) reason.push('missing_student_id');
        if (hours === null) reason.push('missing_or_invalid_hours');
        invalidRows.push({
          file: fileName,
          sheet: sheetName,
          row_number: rowIndex + 1,
          reason: reason.join(','),
          row: row.map(normalizeCell),
        });
        skipped += 1;
        continue;
      }

      const college = normalizeCollegeName(row[columns.college]);
      const grade = normalizeCell(row[columns.grade]);
      const rawPhone = columns.phone === undefined ? '' : normalizeCell(row[columns.phone]);
      const phone = truncate(rawPhone, 20);
      const activityParts = columns.activityColumns
        .map((colIndex) => normalizeCell(row[colIndex]))
        .filter(Boolean);
      const activityDetail = activityParts.join(' | ');

      const record = {
        student_id: studentId,
        student_name: studentName,
        college,
        grade,
        phone,
        phone_was_truncated: rawPhone.length > phone.length,
        activity_date: ACTIVITY_DATE,
        hours,
        source_file: fileName,
        source_sheet: sheetName,
        source_row: rowIndex + 1,
        activity_detail_preview: truncate(activityDetail, 500),
        activity_detail_length: activityDetail.length,
      };
      record.activity_name = makeActivityName(record);
      records.push(record);
      imported += 1;
    }

    sheetSummaries.push({
      sheet: sheetName,
      rows: rows.length,
      header_row: headerIndex + 1,
      imported,
      skipped,
    });
  }

  return { records, invalidRows, sheetSummaries };
}

function chooseDedupedRecord(existing, candidate) {
  if (!existing) return candidate;
  if (candidate.hours > existing.hours) return candidate;
  if (candidate.hours === existing.hours && candidate.activity_detail_length > existing.activity_detail_length) {
    return candidate;
  }
  return existing;
}

function main() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const files = fs
    .readdirSync(sourceDir)
    .filter((file) => file.toLowerCase().endsWith('.xlsx') && !file.startsWith('~$'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const allRecords = [];
  const invalidRows = [];
  const fileSummaries = [];

  for (const file of files) {
    const { records, invalidRows: fileInvalidRows, sheetSummaries } = readWorkbookRecords(path.join(sourceDir, file));
    allRecords.push(...records);
    invalidRows.push(...fileInvalidRows);
    fileSummaries.push({
      file,
      imported_raw: records.length,
      invalid: fileInvalidRows.length,
      sheets: sheetSummaries,
    });
  }

  const groups = new Map();
  for (const record of allRecords) {
    const key = `${record.student_id}\u0000${record.student_name}`;
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }

  const duplicateGroups = [];
  const dedupedRecords = [];

  for (const [key, group] of groups.entries()) {
    const chosen = group.reduce((existing, candidate) => chooseDedupedRecord(existing, candidate), null);
    dedupedRecords.push(chosen);
    if (group.length > 1) {
      duplicateGroups.push({
        key: key.replace('\u0000', ' / '),
        count: group.length,
        chosen: {
          student_id: chosen.student_id,
          student_name: chosen.student_name,
          hours: chosen.hours,
          source_file: chosen.source_file,
          source_sheet: chosen.source_sheet,
          source_row: chosen.source_row,
        },
        candidates: group.map((record) => ({
          hours: record.hours,
          college: record.college,
          grade: record.grade,
          source_file: record.source_file,
          source_sheet: record.source_sheet,
          source_row: record.source_row,
        })),
      });
    }
  }

  dedupedRecords.sort((a, b) => {
    const fileCmp = a.source_file.localeCompare(b.source_file, 'zh-CN');
    if (fileCmp !== 0) return fileCmp;
    const sheetCmp = a.source_sheet.localeCompare(b.source_sheet, 'zh-CN');
    if (sheetCmp !== 0) return sheetCmp;
    return a.source_row - b.source_row;
  });

  const finalByFile = {};
  for (const record of dedupedRecords) {
    finalByFile[record.source_file] = (finalByFile[record.source_file] || 0) + 1;
  }

  const meta = {
    dataset_name: DATASET_NAME,
    activity_date: ACTIVITY_DATE,
    source_dir: sourceDir,
    generated_at: new Date().toISOString(),
    files: files.length,
    raw_records: allRecords.length,
    final_records: dedupedRecords.length,
    invalid_rows: invalidRows.length,
    duplicate_groups: duplicateGroups.length,
    duplicate_rows_removed: allRecords.length - dedupedRecords.length,
    dedupe_policy: 'same student_id + student_name keeps the row with highest hours; ties keep the row with longer activity detail',
    final_by_file: finalByFile,
  };

  const importPayload = {
    meta,
    records: dedupedRecords,
  };

  const auditPayload = {
    meta,
    files: fileSummaries,
    invalid_rows: invalidRows,
    duplicate_groups: duplicateGroups,
  };

  const importPath = path.join(outputDir, 'march-public-import.json');
  const auditPath = path.join(outputDir, 'march-public-audit.json');
  fs.writeFileSync(importPath, JSON.stringify(importPayload, null, 2), 'utf8');
  fs.writeFileSync(auditPath, JSON.stringify(auditPayload, null, 2), 'utf8');

  console.log(JSON.stringify({
    importPath,
    auditPath,
    meta,
  }, null, 2));
}

main();
