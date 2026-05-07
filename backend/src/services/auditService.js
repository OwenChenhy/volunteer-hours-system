const db = require('../db');

async function writeAudit(request, action, targetType, targetId, detail = {}) {
  try {
    await db.query(`
      INSERT INTO operation_logs (user_id, username, action, target_type, target_id, detail, ip)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      request.user?.id || null,
      request.user?.real_name || request.user?.username || null,
      action,
      targetType || null,
      targetId || null,
      detail,
      request.headers['x-real-ip'] || request.headers['x-forwarded-for'] || request.ip || null
    ]);
  } catch (err) {
    request.log?.warn?.({ err }, 'failed to write operation audit log');
  }
}

module.exports = { writeAudit };
