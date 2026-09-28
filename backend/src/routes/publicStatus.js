const fs = require('fs/promises');
const path = require('path');
const db = require('../db');

const TABLES = ['volunteer_logs', 'activities', 'import_batches'];
let cached;
let cachedAt = 0;
let pending;

async function remoteCount(table) {
  const url = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?select=id&limit=1`;
  const response = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Prefer: 'count=exact',
      'User-Agent': 'VolunteerStatus/1.0',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const match = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!match) throw new Error('Missing row count');
  return Number(match[1]);
}

async function backupStatus(now) {
  const directory = process.env.BACKUP_DIR || '/app/backups';
  try {
    const entries = await fs.readdir(directory);
    const dumps = entries.filter((name) => name.endsWith('.dump'));
    if (dumps.length === 0) return { status: 'warning', latest_at: null };
    const files = await Promise.all(dumps.map(async (name) => ({ name, stat: await fs.stat(path.join(directory, name)) })));
    const latest = files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    const ageHours = Math.round((now.getTime() - latest.stat.mtimeMs) / 3600000);
    return { status: ageHours <= Number(process.env.BACKUP_STALE_HOURS || 36) ? 'ok' : 'warning', latest_at: latest.stat.mtime.toISOString(), age_hours: ageHours };
  } catch {
    return { status: 'warning', latest_at: null };
  }
}

async function sourceFilesStatus() {
  const result = await db.query(`
    SELECT DISTINCT source_file FROM volunteer_logs
    WHERE source = 'imported' AND source_file IS NOT NULL
  `);
  const roots = (process.env.IMPORT_SOURCE_DIRS || process.env.IMPORT_SOURCE_DIR || '')
    .split('||').filter(Boolean);
  const files = result.rows.map((row) => row.source_file);
  let available = 0;
  for (const file of files) {
    if (path.basename(file) !== file) continue;
    const found = await Promise.all(roots.map((root) => fs.access(path.join(root, file)).then(() => true, () => false)));
    if (found.some(Boolean)) available += 1;
  }
  return { status: available === files.length ? 'ok' : 'warning', expected: files.length, available };
}

async function buildStatus() {
  const now = new Date();
  let database;
  try {
    const result = await db.query(`
      SELECT
        (SELECT count(*)::int FROM volunteer_logs) AS volunteer_logs,
        (SELECT count(*)::int FROM activities) AS activities,
        (SELECT count(*)::int FROM import_batches) AS import_batches,
        (SELECT coalesce(sum(hours), 0) FROM volunteer_logs) AS total_hours
    `);
    database = { status: 'ok', ...result.rows[0], total_hours: Number(result.rows[0].total_hours) };
  } catch {
    database = { status: 'error' };
  }

  let supabase = { status: 'unavailable' };
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const counts = await Promise.all(TABLES.map(remoteCount));
      supabase = { status: 'ok', counts: Object.fromEntries(TABLES.map((table, index) => [table, counts[index]])) };
      if (database.status === 'ok' && TABLES.some((table) => database[table] !== supabase.counts[table])) {
        supabase.status = 'warning';
      }
    } catch {
      supabase = { status: 'error' };
    }
  }

  const backup = await backupStatus(now);
  let source_files;
  try {
    source_files = await sourceFilesStatus();
  } catch {
    source_files = { status: 'error', expected: 0, available: 0 };
  }
  const overall = database.status === 'error' ? 'error'
    : supabase.status === 'ok' && backup.status === 'ok' && source_files.status === 'ok' ? 'ok' : 'warning';
  return { checked_at: now.toISOString(), overall, api: { status: 'ok' }, database, supabase, backup, source_files };
}

module.exports = async function (fastify) {
  fastify.get('/', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (cached && Date.now() - cachedAt < 60000) return cached;
    if (!pending) pending = buildStatus().finally(() => { pending = null; });
    cached = await pending;
    cachedAt = Date.now();
    return cached;
  });
};
