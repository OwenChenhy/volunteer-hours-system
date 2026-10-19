const fs = require('fs');
const path = require('path');
const db = require('../db');
const cache = require('../cache/redis');
const { authenticate } = require('../middlewares/auth');
const { requireCapability } = require('../middlewares/rbac');

const BACKUP_STALE_HOURS = Number(process.env.BACKUP_STALE_HOURS || 36);

module.exports = async function (fastify, opts) {
  fastify.addHook('preHandler', authenticate);
  fastify.addHook('preHandler', requireCapability('ops:read'));

  const currentStatus = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return buildStatus();
  };
  fastify.get('/status', currentStatus);
  fastify.get('/monitoring', currentStatus);
};

async function buildStatus() {
  const now = new Date();
  const alerts = [];
  const status = {
    checked_at: now.toISOString(),
    database: await checkDatabase(alerts),
    redis: await cache.getStatus(),
    backups: await checkBackups(now, alerts),
    supabase: checkSupabase(),
    monitoring: {
      stale_backup_hours: BACKUP_STALE_HOURS,
      alerts
    }
  };
  if (status.redis.configured && !status.redis.ok) {
    alerts.push({ code: 'redis_unavailable', level: 'warning', message: status.redis.message });
  }
  status.ok = alerts.length === 0 || alerts.every((alert) => alert.level !== 'critical');
  status.api = {
    status: 'ok',
    checked_at: status.checked_at,
    message: 'Fastify API 可用'
  };
  status.backup = status.backups;
  status.monitor = {
    status: alerts.some((alert) => alert.level === 'critical') ? 'error' : alerts.length > 0 ? 'warning' : 'ok',
    checked_at: status.checked_at,
    message: alerts.length > 0 ? `${alerts.length} 个告警` : '无告警'
  };
  return status;
}

async function checkDatabase(alerts) {
  try {
    const ping = await db.query('SELECT 1 AS ok');
    const counts = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM volunteer_logs) AS volunteer_logs,
        (SELECT COUNT(*)::int FROM import_batches) AS import_batches,
        (SELECT COUNT(*)::int FROM users) AS users
    `);
    return {
      status: 'ok',
      ok: ping.rows[0]?.ok === 1,
      counts: counts.rows[0],
      record_count: counts.rows[0]?.volunteer_logs || 0,
      logs_count: counts.rows[0]?.volunteer_logs || 0
    };
  } catch (err) {
    alerts.push({
      code: 'db_error',
      level: 'critical',
      message: '数据库连接或统计查询失败'
    });
    return { status: 'error', ok: false, error: err.message };
  }
}

async function checkBackups(now, alerts) {
  const backupDir = await resolveBackupDir();
  if (!backupDir) {
    alerts.push({
      code: 'backup_missing',
      level: 'warning',
      message: '未找到备份目录，确认 docker compose 是否挂载 ./backups'
    });
    return { status: 'warning', ok: false, directory: null, latest: null };
  }

  const files = await fs.promises.readdir(backupDir, { withFileTypes: true });
  const backupFiles = files
    .filter((item) => item.isFile() && /\.(dump|json|list)$/i.test(item.name))
    .map((item) => path.join(backupDir, item.name));

  if (backupFiles.length === 0) {
    alerts.push({
      code: 'backup_missing',
      level: 'warning',
      message: '备份目录存在，但没有找到 dump/json/list 备份文件'
    });
    return { status: 'warning', ok: false, directory: backupDir, latest: null };
  }

  const stats = await Promise.all(backupFiles.map(async (file) => ({
    file,
    name: path.basename(file),
    stat: await fs.promises.stat(file)
  })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const latest = stats[0];
  const ageHours = Math.round(((now.getTime() - latest.stat.mtimeMs) / 36e5) * 10) / 10;
  const manifest = await readLatestManifest(stats);

  if (ageHours > BACKUP_STALE_HOURS) {
    alerts.push({
      code: 'backup_stale',
      level: 'warning',
      message: `最近备份距今 ${ageHours} 小时，超过 ${BACKUP_STALE_HOURS} 小时阈值`
    });
  }

  return {
    status: ageHours > BACKUP_STALE_HOURS ? 'warning' : 'ok',
    ok: true,
    directory: backupDir,
    latest: {
      file: latest.name,
      filename: latest.name,
      modified_at: latest.stat.mtime.toISOString(),
      created_at: latest.stat.mtime.toISOString(),
      age_hours: ageHours,
      size_bytes: latest.stat.size
    },
    latest_file: latest.name,
    latest_backup_at: latest.stat.mtime.toISOString(),
    manifest
  };
}

async function resolveBackupDir() {
  const candidates = [
    process.env.BACKUP_DIR,
    path.resolve(process.cwd(), 'backups'),
    path.resolve(process.cwd(), '..', 'backups'),
    '/app/backups'
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch (err) {
      // Try the next known location.
    }
  }
  return null;
}

async function readLatestManifest(stats) {
  const manifest = stats.find((item) => item.name.endsWith('.json'));
  if (!manifest) return null;
  try {
    return JSON.parse(await fs.promises.readFile(manifest.file, 'utf8'));
  } catch (err) {
    return { file: manifest.name, error: 'manifest_parse_failed' };
  }
}

function checkSupabase() {
  const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_BACKUP_BUCKET);
  return {
    status: configured ? 'enabled' : 'disabled',
    configured,
    url_configured: Boolean(process.env.SUPABASE_URL),
    service_role_key_configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    backup_bucket: process.env.SUPABASE_BACKUP_BUCKET || null,
    bucket: process.env.SUPABASE_BACKUP_BUCKET || null,
    backup_prefix: process.env.SUPABASE_BACKUP_PREFIX || 'postgres'
  };
}
