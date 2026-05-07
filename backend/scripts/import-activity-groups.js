#!/usr/bin/env node
const fs = require('fs');
const { Pool } = require('pg');

let DATASET_NAME = process.env.PUBLIC_DATASET_NAME || '2025-2026志愿者时长库3月公示';
const LEGACY_PLACEHOLDER_PATTERN = '(源表|未拆分|拆分时长|拆分明细|已拆分|累计未拆分)';

const payloadPath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!payloadPath) {
  console.error('Usage: node scripts/import-activity-groups.js <activities-for-import.json> [--dry-run]');
  process.exit(2);
}

function asText(value, field, maxLength) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) throw new Error(`Missing required field: ${field}`);
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} chars`);
  return text;
}

function optionalText(value, maxLength) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseDate(value) {
  const text = asText(value, 'activity_date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid activity_date: ${text}`);
  return text;
}

function safeSourceKey(value) {
  return asText(value, 'source_key', 700).replace(/\u0000/g, '\u241f');
}

function normalizeActivity(row) {
  const summary = row.summary || {};
  const activityDate = parseDate(summary.activity_date || String(row.start_time || '').slice(0, 10));
  return {
    source_key: safeSourceKey(row.source_key),
    name: asText(row.name, 'name', 256),
    activity_date: activityDate,
    start_time: asText(row.start_time, 'start_time', 64),
    end_time: asText(row.end_time, 'end_time', 64),
    location: optionalText(row.location, 256),
    org_name: optionalText(row.org_name, 128),
    description: optionalText(row.description, 5000),
    record_count: Number(summary.record_count || 0),
    student_count: Number(summary.student_count || 0),
    total_hours: Number(summary.total_hours || 0),
    min_hours: Number(summary.min_hours || 0),
    max_hours: Number(summary.max_hours || 0),
    avg_hours: Number(summary.avg_hours || 0),
  };
}

function loadPayload() {
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  if (!payload || !Array.isArray(payload.activities)) {
    throw new Error('Payload must contain an activities array');
  }
  const activities = payload.activities.map(normalizeActivity);
  const seen = new Set();
  const duplicates = [];
  for (const item of activities) {
    if (seen.has(item.source_key)) duplicates.push(item.source_key);
    seen.add(item.source_key);
  }
  if (duplicates.length > 0) {
    throw new Error(`Duplicate activity source_key values: ${duplicates.slice(0, 5).join(', ')}`);
  }
  return { meta: payload.meta || {}, activities };
}

async function insertStage(client, activities) {
  await client.query(`
    CREATE TEMP TABLE activity_import_stage (
      source_key TEXT PRIMARY KEY,
      name VARCHAR(256) NOT NULL,
      activity_date DATE NOT NULL,
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      location VARCHAR(256),
      org_name VARCHAR(128),
      description TEXT,
      record_count INTEGER,
      student_count INTEGER,
      total_hours NUMERIC(12,1),
      min_hours NUMERIC(8,1),
      max_hours NUMERIC(8,1),
      avg_hours NUMERIC(8,2)
    ) ON COMMIT DROP
  `);

  const chunkSize = 500;
  let inserted = 0;
  for (let offset = 0; offset < activities.length; offset += chunkSize) {
    const chunk = activities.slice(offset, offset + chunkSize);
    const params = [];
    const values = chunk.map((activity, index) => {
      const base = index * 14;
      params.push(
        activity.source_key,
        activity.name,
        activity.activity_date,
        activity.start_time,
        activity.end_time,
        activity.location,
        activity.org_name,
        activity.description,
        activity.record_count,
        activity.student_count,
        activity.total_hours,
        activity.min_hours,
        activity.max_hours,
        activity.avg_hours,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}::date, $${base + 4}::timestamptz, $${base + 5}::timestamptz, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`;
    });
    const result = await client.query(
      `
        INSERT INTO activity_import_stage (
          source_key, name, activity_date, start_time, end_time, location, org_name, description,
          record_count, student_count, total_hours, min_hours, max_hours, avg_hours
        )
        VALUES ${values.join(', ')}
      `,
      params,
    );
    inserted += result.rowCount;
  }
  return inserted;
}

async function scalar(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count || 0);
}

async function main() {
  const { meta, activities } = loadPayload();
  if (!process.env.PUBLIC_DATASET_NAME && meta.dataset_name) {
    DATASET_NAME = String(meta.dataset_name).trim();
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const summary = {
    dry_run: dryRun,
    dataset_name: DATASET_NAME,
    payload_path: payloadPath,
    payload_meta: meta,
    activity_groups_in_payload: activities.length,
  };

  try {
    await client.query('BEGIN');

    const admin = await client.query(
      "SELECT id, username FROM users WHERE username = 'admin' AND role IN ('admin', 'super_admin') LIMIT 1",
    );
    if (admin.rowCount === 0) throw new Error('Admin user not found');
    const adminId = admin.rows[0].id;
    summary.created_by = admin.rows[0].username;

    const latestBatch = await client.query(
      `
        SELECT id, record_count, created_at
        FROM import_batches
        WHERE note = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [DATASET_NAME],
    );
    if (latestBatch.rowCount === 0) throw new Error(`Import batch not found: ${DATASET_NAME}`);
    const batchId = latestBatch.rows[0].id;
    summary.import_batch_id = batchId;
    summary.import_batch_record_count = Number(latestBatch.rows[0].record_count || 0);

    summary.stage_inserted = await insertStage(client, activities);

    const normalizedNames = await client.query(
      `
        UPDATE volunteer_logs
        SET activity_name = '累计时长记录'
        WHERE import_batch_id = $1
          AND activity_name ~ $2
        RETURNING id
      `,
      [batchId, LEGACY_PLACEHOLDER_PATTERN],
    );
    summary.legacy_activity_names_normalized = normalizedNames.rowCount;

    const normalizedPeriods = await client.query(
      `
        UPDATE volunteer_logs
        SET activity_period = '累计记录'
        WHERE import_batch_id = $1
          AND coalesce(activity_period, '') ~ $2
        RETURNING id
      `,
      [batchId, LEGACY_PLACEHOLDER_PATTERN],
    );
    summary.legacy_activity_periods_normalized = normalizedPeriods.rowCount;

    summary.logs_in_batch = await scalar(client, 'SELECT COUNT(*)::int AS count FROM volunteer_logs WHERE import_batch_id = $1', [batchId]);
    summary.logs_without_activity_before = await scalar(
      client,
      'SELECT COUNT(*)::int AS count FROM volunteer_logs WHERE import_batch_id = $1 AND activity_id IS NULL',
      [batchId],
    );

    const insertedActivities = await client.query(
      `
        INSERT INTO activities (name, start_time, end_time, location, org_name, description, created_by, status)
        SELECT s.name, s.start_time, s.end_time, s.location, s.org_name, s.description, $1, 'active'::activity_status
        FROM activity_import_stage s
        WHERE NOT EXISTS (
          SELECT 1
          FROM activities a
          WHERE a.name = s.name
            AND a.start_time = s.start_time
            AND a.end_time = s.end_time
            AND coalesce(a.location, '') = coalesce(s.location, '')
            AND coalesce(a.description, '') LIKE $2
        )
        RETURNING id
      `,
      [adminId, `来源：${DATASET_NAME}%`],
    );
    summary.activities_inserted = insertedActivities.rowCount;

    summary.activities_reused = await scalar(
      client,
      `
        SELECT COUNT(*)::int AS count
        FROM activity_import_stage s
        WHERE EXISTS (
          SELECT 1
          FROM activities a
          WHERE a.name = s.name
            AND a.start_time = s.start_time
            AND a.end_time = s.end_time
            AND coalesce(a.location, '') = coalesce(s.location, '')
            AND coalesce(a.description, '') LIKE $1
        )
      `,
      [`来源：${DATASET_NAME}%`],
    );

    const ambiguous = await client.query(
      `
        WITH matches AS (
          SELECT s.source_key, COUNT(a.id)::int AS count
          FROM activity_import_stage s
          JOIN activities a
            ON a.name = s.name
           AND a.start_time = s.start_time
           AND a.end_time = s.end_time
           AND coalesce(a.location, '') = coalesce(s.location, '')
           AND coalesce(a.description, '') LIKE $1
          GROUP BY s.source_key
        )
        SELECT source_key, count
        FROM matches
        WHERE count > 1
        ORDER BY count DESC, source_key
        LIMIT 20
      `,
      [`来源：${DATASET_NAME}%`],
    );
    summary.ambiguous_activity_keys = ambiguous.rows;

    const linked = await client.query(
      `
        WITH activity_map AS (
          SELECT DISTINCT ON (s.source_key)
            s.name,
            s.location AS activity_period,
            s.activity_date,
            a.id AS activity_id
          FROM activity_import_stage s
          JOIN activities a
            ON a.name = s.name
           AND a.start_time = s.start_time
           AND a.end_time = s.end_time
           AND coalesce(a.location, '') = coalesce(s.location, '')
           AND coalesce(a.description, '') LIKE $2
          ORDER BY s.source_key, a.created_at DESC, a.id
        )
        UPDATE volunteer_logs l
        SET activity_id = m.activity_id
        FROM activity_map m
        WHERE l.import_batch_id = $1
          AND l.activity_name = m.name
          AND coalesce(l.activity_period, '') = coalesce(m.activity_period, '')
          AND l.activity_date = m.activity_date
          AND l.activity_id IS DISTINCT FROM m.activity_id
        RETURNING l.id
      `,
      [batchId, `来源：${DATASET_NAME}%`],
    );
    summary.logs_linked_or_corrected = linked.rowCount;

    summary.logs_without_activity_after = await scalar(
      client,
      'SELECT COUNT(*)::int AS count FROM volunteer_logs WHERE import_batch_id = $1 AND activity_id IS NULL',
      [batchId],
    );

    const unmatched = await client.query(
      `
        SELECT activity_name, activity_period, activity_date, COUNT(*)::int AS rows
        FROM volunteer_logs
        WHERE import_batch_id = $1
          AND activity_id IS NULL
        GROUP BY activity_name, activity_period, activity_date
        ORDER BY rows DESC, activity_name
        LIMIT 20
      `,
      [batchId],
    );
    summary.unmatched_examples = unmatched.rows;

    const verification = await client.query(
      `
        SELECT
          COUNT(*)::int AS logs,
          COUNT(*) FILTER (WHERE activity_id IS NOT NULL)::int AS logs_with_activity,
          COUNT(DISTINCT activity_id)::int AS linked_activities,
          COALESCE(SUM(hours), 0)::numeric(12,1)::text AS total_hours
        FROM volunteer_logs
        WHERE import_batch_id = $1
      `,
      [batchId],
    );
    summary.verification = verification.rows[0];

    await client.query(
      `
        INSERT INTO operation_logs (user_id, username, action, target_type, target_id, detail)
        VALUES ($1, 'admin', 'activities.import_public_groups', 'import_batch', $2, $3::jsonb)
      `,
      [
        adminId,
        batchId,
        JSON.stringify({
          dataset_name: DATASET_NAME,
          dry_run: dryRun,
          activity_groups_in_payload: activities.length,
          activities_inserted: summary.activities_inserted,
          activities_reused: summary.activities_reused,
          logs_linked_or_corrected: summary.logs_linked_or_corrected,
          logs_without_activity_after: summary.logs_without_activity_after,
        }),
      ],
    );

    if (dryRun) {
      await client.query('ROLLBACK');
      summary.rolled_back = true;
    } else {
      await client.query('COMMIT');
      summary.committed = true;
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    summary.error = error.message;
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
