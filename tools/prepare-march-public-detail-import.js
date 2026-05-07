const fs = require('fs');
const path = require('path');
const { normalizeCollegeName } = require('../backend/src/utils/collegeNames');

const DEFAULT_DATASET_NAME = '2025-2026志愿者时长库3月公示';
const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '..', DEFAULT_DATASET_NAME);
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '..', 'import-output');

const sourceDir = path.resolve(process.argv[2] || DEFAULT_SOURCE_DIR);
const outputDir = path.resolve(process.argv[3] || DEFAULT_OUTPUT_DIR);
const DATASET_NAME = process.env.PUBLIC_DATASET_NAME || path.basename(sourceDir);
let excelJsModule;

function loadPackage(name) {
  try {
    return require(name);
  } catch (error) {
    return require(require.resolve(name, { paths: [path.resolve(__dirname, '..', 'backend')] }));
  }
}

function loadExcelJs() {
  if (!excelJsModule) excelJsModule = loadPackage('exceljs');
  return excelJsModule;
}

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
      Number(row.some((header) => header === '姓名' || header.endsWith('姓名'))) +
      Number(row.some((header) => header === '学号' || header.includes('学号'))) +
      Number(row.some((header) => header.includes('服务时长') || header.includes('志愿时长') || header.includes('总时长')));

    if (score >= 2 && (!best || score > best.score)) {
      best = { rowIndex, score };
    }
  }
  return best ? best.rowIndex : -1;
}

function findColumns(headerRow) {
  const columns = { activityColumns: [] };

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

    const isActivityColumn =
      (header.includes('活动') || header.includes('补录') || header.includes('寒暑')) &&
      !header.includes('服务时长') &&
      !header.includes('志愿时长');
    if (isActivityColumn) {
      columns.activityColumns.push({ index, header: normalizeCell(rawHeader) });
    }
  });

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

function activityDateForPeriod(period) {
  const header = normalizeHeader(period);
  const range = header.match(/(20\d{2})-(20\d{2})(上|下)半/);
  if (range) {
    const startYear = Number(range[1]);
    const endYear = Number(range[2]);
    return range[3] === '上' ? `${startYear}-12-31` : `${endYear}-06-30`;
  }

  const singleYear = header.match(/(20\d{2})/);
  if (singleYear) {
    return `${singleYear[1]}-12-31`;
  }

  return '2026-03-31';
}

function normalizeActivityText(value) {
  return normalizeCell(value)
    .replace(/[（）]/g, (char) => (char === '（' ? '(' : ')'))
    .replace(/；/g, '、');
}

function repairMalformedHourClosings(text) {
  return text.replace(
    /(\d+(?:\.\d+)?)\s*(小时|h|H)\s*(?=(?:[、,，。；;]\s*)?[^()]{1,80}\(\s*\d+(?:\.\d+)?\s*(?:小时|h|H))/g,
    '$1$2)',
  );
}

function cleanActivityName(value) {
  return value
    .trim()
    .replace(/^\d+(?:\.\d+)?\s*(?:小时|h|H)\s*[、,，。；;：:"]*/g, '')
    .replace(/[、,，。；;：:"]+$/g, '')
    .replace(/^[、,，。；;：:"]+/g, '')
    .replace(/^[\\/]+|[\\/]+$/g, '')
    .trim();
}

function addUnresolvedActivities(fragment, unresolved) {
  const normalized = fragment.replace(/[|｜]/g, '、');
  for (const part of normalized.split(/[、,，。；;]+/)) {
    const name = cleanActivityName(part);
    if (
      name.length >= 2 &&
      !/[()]/.test(name) &&
      !/\d+(?:\.\d+)?\s*(?:小时|h|H)/.test(name)
    ) {
      unresolved.push({ activity_name: truncate(name, 256) });
    }
  }
}

function extractActivityDetails(value) {
  const text = repairMalformedHourClosings(normalizeActivityText(value));
  const entries = [];
  const unresolved = [];
  const pattern = /([^()]+?)\s*\(\s*(\d+(?:\.\d+)?)\s*(?:小时|h|H)\s*\)/g;
  let match;
  let lastIndex = 0;

  while ((match = pattern.exec(text))) {
    addUnresolvedActivities(text.slice(lastIndex, match.index), unresolved);
    const name = cleanActivityName(match[1]);
    const hours = Math.round(Number(match[2]) * 10) / 10;
    if (name && Number.isFinite(hours) && hours > 0) {
      entries.push({ activity_name: truncate(name, 256), hours });
    }
    lastIndex = pattern.lastIndex;
  }
  addUnresolvedActivities(text.slice(lastIndex), unresolved);

  return { entries, unresolved };
}

function extractActivities(value) {
  return extractActivityDetails(value).entries;
}

function cellValue(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return value.text;
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return value.result;
    if (Object.prototype.hasOwnProperty.call(value, 'hyperlink')) return value.text || value.hyperlink;
  }
  return value;
}

async function readWorkbookRows(filePath) {
  const ExcelJS = loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const fileName = path.basename(filePath);
  const rowsOut = [];
  const invalidRows = [];
  const sheetSummaries = [];

  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (worksheetRow) => {
      const values = [];
      worksheetRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        values[colNumber - 1] = cellValue(cell.value);
      });
      if (values.some((value) => normalizeCell(value))) rows.push(values);
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
      const reportedHours = parseHours(row[columns.hours]);

      const hasAnyData = row.some((cell) => normalizeCell(cell));
      if (!hasAnyData) {
        skipped += 1;
        continue;
      }

      if (!studentName || !studentId || reportedHours === null) {
        const reason = [];
        if (!studentName) reason.push('missing_student_name');
        if (!studentId) reason.push('missing_student_id');
        if (reportedHours === null) reason.push('missing_or_invalid_hours');
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

      const entries = [];
      const unresolvedEntries = [];
      let detailLength = 0;
      for (const activityColumn of columns.activityColumns) {
        const rawText = normalizeCell(row[activityColumn.index]);
        detailLength += rawText.length;
        const details = extractActivityDetails(rawText);
        for (const activity of details.entries) {
          entries.push({
            ...activity,
            activity_period: activityColumn.header,
            activity_date: activityDateForPeriod(activityColumn.header),
            source_column: activityColumn.header,
          });
        }
        for (const activity of details.unresolved) {
          unresolvedEntries.push({
            ...activity,
            activity_period: activityColumn.header,
            activity_date: activityDateForPeriod(activityColumn.header),
            source_column: activityColumn.header,
          });
        }
      }

      rowsOut.push({
        student_id: studentId,
        student_name: studentName,
        college: normalizeCollegeName(row[columns.college]),
        grade: normalizeCell(row[columns.grade]),
        phone: truncate(columns.phone === undefined ? '' : normalizeCell(row[columns.phone]), 20),
        source_file: fileName,
        source_sheet: sheetName,
        source_row: rowIndex + 1,
        source_total_hours: reportedHours,
        parsed_hours: Math.round(entries.reduce((sum, entry) => sum + entry.hours, 0) * 10) / 10,
        detail_length: detailLength,
        entries,
        unresolved_entries: unresolvedEntries,
      });
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

  return { rows: rowsOut, invalidRows, sheetSummaries };
}

function chooseDedupedRow(existing, candidate) {
  if (!existing) return candidate;
  if (candidate.source_total_hours > existing.source_total_hours) return candidate;
  if (
    candidate.source_total_hours === existing.source_total_hours &&
    candidate.detail_length > existing.detail_length
  ) {
    return candidate;
  }
  return existing;
}

function baseRecord(row, overrides) {
  return {
    student_id: row.student_id,
    student_name: row.student_name,
    college: row.college,
    grade: row.grade,
    phone: row.phone,
    source_file: row.source_file,
    source_sheet: row.source_sheet,
    source_row: row.source_row,
    source_total_hours: row.source_total_hours,
    ...overrides,
  };
}

function buildImportRecords(row, audit) {
  const diff = Math.round((row.source_total_hours - row.parsed_hours) * 10) / 10;

  if (row.entries.length === 0) {
    audit.summary_records += 1;
    audit.no_activity_rows += 1;
    return [
      baseRecord(row, {
        activity_name: '源表累计时长（未列明活动明细）',
        activity_period: '源表累计',
        activity_date: '2026-03-31',
        hours: row.source_total_hours,
        import_detail_status: 'summary_no_detail',
      }),
    ];
  }

  if (diff < -0.05) {
    audit.summary_records += 1;
    audit.conflict_rows += 1;
    audit.conflict_over_hours = Math.round((audit.conflict_over_hours + Math.abs(diff)) * 10) / 10;
    audit.conflicts.push({
      student_id: row.student_id,
      student_name: row.student_name,
      source_file: row.source_file,
      source_sheet: row.source_sheet,
      source_row: row.source_row,
      source_total_hours: row.source_total_hours,
      parsed_hours: row.parsed_hours,
      diff,
      entries: row.entries.slice(0, 20),
    });
    return [
      baseRecord(row, {
        activity_name: '源表累计时长（活动明细合计超过总时长，待人工复核）',
        activity_period: '源表累计',
        activity_date: '2026-03-31',
        hours: row.source_total_hours,
        import_detail_status: 'summary_conflict',
      }),
    ];
  }

  const records = row.entries.map((entry) =>
    baseRecord(row, {
      activity_name: entry.activity_name,
      activity_period: entry.activity_period,
      activity_date: entry.activity_date,
      hours: entry.hours,
      import_detail_status: 'parsed',
    }),
  );

  audit.parsed_activity_records += records.length;

  if (diff > 0.05) {
    const unresolvedActivity = row.unresolved_entries?.length === 1 ? row.unresolved_entries[0] : null;
    audit.supplement_records += 1;
    audit.supplement_hours = Math.round((audit.supplement_hours + diff) * 10) / 10;
    records.push(
      baseRecord(row, {
        activity_name: unresolvedActivity?.activity_name || '源表累计未拆分时长',
        activity_period: unresolvedActivity?.activity_period || '源表累计',
        activity_date: unresolvedActivity?.activity_date || '2026-03-31',
        hours: diff,
        import_detail_status: 'supplement',
      }),
    );
  }

  return records;
}

async function main() {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const files = fs
    .readdirSync(sourceDir)
    .filter((file) => file.toLowerCase().endsWith('.xlsx') && !file.startsWith('~$'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));

  const rawRows = [];
  const invalidRows = [];
  const fileSummaries = [];

  for (const file of files) {
    const { rows, invalidRows: fileInvalidRows, sheetSummaries } = await readWorkbookRows(path.join(sourceDir, file));
    rawRows.push(...rows);
    invalidRows.push(...fileInvalidRows);
    fileSummaries.push({
      file,
      imported_raw: rows.length,
      invalid: fileInvalidRows.length,
      sheets: sheetSummaries,
    });
  }

  const groups = new Map();
  for (const row of rawRows) {
    const key = `${row.student_id}\u0000${row.student_name}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const duplicateGroups = [];
  const dedupedRows = [];
  for (const [key, group] of groups.entries()) {
    const chosen = group.reduce((existing, candidate) => chooseDedupedRow(existing, candidate), null);
    dedupedRows.push(chosen);
    if (group.length > 1) {
      duplicateGroups.push({
        key: key.replace('\u0000', ' / '),
        count: group.length,
        chosen: {
          student_id: chosen.student_id,
          student_name: chosen.student_name,
          source_total_hours: chosen.source_total_hours,
          parsed_hours: chosen.parsed_hours,
          source_file: chosen.source_file,
          source_sheet: chosen.source_sheet,
          source_row: chosen.source_row,
        },
      });
    }
  }

  dedupedRows.sort((a, b) => {
    const fileCmp = a.source_file.localeCompare(b.source_file, 'zh-CN');
    if (fileCmp !== 0) return fileCmp;
    const sheetCmp = a.source_sheet.localeCompare(b.source_sheet, 'zh-CN');
    if (sheetCmp !== 0) return sheetCmp;
    return a.source_row - b.source_row;
  });

  const audit = {
    parsed_activity_records: 0,
    supplement_records: 0,
    supplement_hours: 0,
    summary_records: 0,
    no_activity_rows: 0,
    conflict_rows: 0,
    conflict_over_hours: 0,
    conflicts: [],
  };

  const records = dedupedRows.flatMap((row) => buildImportRecords(row, audit));
  const sourceTotalHours = Math.round(dedupedRows.reduce((sum, row) => sum + row.source_total_hours, 0) * 10) / 10;
  const outputTotalHours = Math.round(records.reduce((sum, row) => sum + row.hours, 0) * 10) / 10;

  const meta = {
    dataset_name: DATASET_NAME,
    import_mode: 'activity_detail',
    activity_date_policy: 'source files do not contain exact activity dates; imported activity_date is a sortable period anchor, and activity_period keeps the visible semester/source period',
    source_dir: sourceDir,
    generated_at: new Date().toISOString(),
    files: files.length,
    raw_student_rows: rawRows.length,
    final_students: dedupedRows.length,
    final_records: records.length,
    invalid_rows: invalidRows.length,
    duplicate_groups: duplicateGroups.length,
    duplicate_rows_removed: rawRows.length - dedupedRows.length,
    source_total_hours: sourceTotalHours,
    output_total_hours: outputTotalHours,
    total_hours_match: sourceTotalHours === outputTotalHours,
    detail_policy: 'exact/under-total rows import parsed activities; under-total rows receive a supplement record; over-total rows use one source-total summary record and are listed in audit conflicts',
    ...audit,
    conflicts: undefined,
  };

  const importPayload = { meta, records };
  const auditPayload = {
    meta: { ...meta, conflicts: undefined },
    files: fileSummaries,
    invalid_rows: invalidRows,
    duplicate_groups: duplicateGroups,
    conflicts: audit.conflicts,
  };

  const importPath = path.join(outputDir, 'march-public-detail-import.json');
  const auditPath = path.join(outputDir, 'march-public-detail-audit.json');
  fs.writeFileSync(importPath, JSON.stringify(importPayload, null, 2), 'utf8');
  fs.writeFileSync(auditPath, JSON.stringify(auditPayload, null, 2), 'utf8');

  console.log(JSON.stringify({ importPath, auditPath, meta }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  extractActivities,
  extractActivityDetails,
  normalizeActivityText,
  repairMalformedHourClosings,
};
