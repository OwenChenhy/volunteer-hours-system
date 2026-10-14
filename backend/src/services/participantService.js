const ExcelJS = require('exceljs');
const {
  normalizeCollegeName,
  isFormalCollegeName
} = require('../utils/collegeNames');
async function validateParticipants(client, user, activity, input) {
  if (!Array.isArray(input) || !input.length || input.length > 1000) throw Object.assign(new Error('名单须包含1至1000条记录'), {
    statusCode: 400
  });
  const existing = (await client.query(`SELECT student_id,student_name FROM volunteer_logs
    WHERE status IN ('pending','approved','rejected') AND is_adjustment=false
      AND (activity_id=$1 OR (activity_name=$2 AND activity_date=$3::date))`, [activity.id, activity.name, activity.activity_date])).rows;
  const seen = new Set();
  return input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) item = {};
    const row = {
      student_id: String(item.student_id || '').trim(),
      student_name: String(item.student_name || '').trim(),
      college: normalizeCollegeName(item.college || (user.role === 'college_admin' ? user.org_name : activity.org_name)) || '',
      grade: String(item.grade || '').trim(),
      phone: String(item.phone || '').trim(),
      hours: Number(item.hours),
      sheet: item.sheet || '',
      row: item.row || index + 1
    };
    const errors = [];
    if (!row.student_id || row.student_id.length > 32) errors.push('学号不能为空且须不超过32字');
    if (!row.student_name || row.student_name.length > 64) errors.push('姓名不能为空且须不超过64字');
    if (!row.college || !isFormalCollegeName(row.college)) errors.push('请填写正式学院名称');
    if (user.role === 'college_admin' && row.college !== normalizeCollegeName(user.org_name)) errors.push('只能提交本学院学生');
    if (!Number.isFinite(row.hours) || row.hours <= 0 || row.hours > 9999.9 || Math.abs(row.hours * 10 - Math.round(row.hours * 10)) > 1e-7) errors.push('时长须为正数，最多一位小数且不超过9999.9');
    if (row.grade.length > 16) errors.push('年级不超过16字');
    if (row.phone.length > 20) errors.push('联系方式不超过20字');
    const duplicate = seen.has(row.student_id) || existing.some(record => record.student_id === row.student_id);
    if (duplicate) errors.push('同一活动已存在该学号，或名单内重复；请修正或移除');
    seen.add(row.student_id);
    return {
      ...row,
      duplicate,
      errors
    };
  });
}
async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw Object.assign(new Error('文件无法读取，请确认是有效的.xlsx文件'), {
      statusCode: 400
    });
  }
  const aliases = {
    student_id: ['学号', 'student_id'],
    student_name: ['姓名', '学生姓名', 'student_name'],
    college: ['学院', 'college'],
    grade: ['年级', 'grade'],
    hours: ['服务时长（小时）', '服务时长(小时)', '服务时长', '志愿时长', '时长', 'hours'],
    phone: ['联系方式', '联系电话', 'phone']
  };
  const rows = [];
  for (const sheet of workbook.worksheets) {
    let columns, header;
    for (let n = 1; n <= Math.min(12, sheet.rowCount); n++) {
      const candidate = {};
      sheet.getRow(n).eachCell((cell, column) => {
        const text = String(cell.text || '').trim().replace(/\s/g, '');
        for (const [field, names] of Object.entries(aliases)) if (names.includes(text)) candidate[field] = column;
      });
      if (candidate.student_id && candidate.student_name && candidate.hours) {
        columns = candidate;
        header = n;
        break;
      }
    }
    if (!header) continue;
    for (let n = header + 1; n <= sheet.rowCount; n++) {
      const row = {
        sheet: sheet.name,
        row: n
      };
      for (const [field, column] of Object.entries(columns)) row[field] = String(sheet.getRow(n).getCell(column).text || '').trim();
      if (Object.entries(row).some(([key, value]) => !['sheet', 'row'].includes(key) && value)) rows.push(row);
    }
  }
  if (!rows.length) throw Object.assign(new Error('未识别到名单，请使用含学号、姓名、时长表头的模板'), {
    statusCode: 400
  });
  return rows;
}
module.exports = {
  validateParticipants,
  parseWorkbook
};
