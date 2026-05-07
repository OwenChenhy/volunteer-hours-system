const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let normalizeCollegeName = (value) => (value === null || value === undefined ? '' : String(value).trim());
try {
  ({ normalizeCollegeName } = require('../backend/src/utils/collegeNames'));
} catch {
  try {
    ({ normalizeCollegeName } = require('/app/src/utils/collegeNames'));
  } catch {
    // Keep identity fallback for one-off environments without the app source tree.
  }
}

const payloadPath = process.argv[2] || '/tmp/march-public-import.json';
const payloadMeta = (() => {
  try {
    return JSON.parse(fs.readFileSync(payloadPath, 'utf8')).meta || {};
  } catch {
    return {};
  }
})();
const DATASET_NAME = process.env.PUBLIC_DATASET_NAME || payloadMeta.dataset_name || '2025-2026志愿者时长库3月公示';
const IMPORT_FILENAME = process.env.PUBLIC_IMPORT_FILENAME || `${DATASET_NAME}.json`;
const dryRun = process.argv.includes('--dry-run');

function requireString(value, field, maxLength) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) throw new Error(`Missing required field ${field}`);
  if (text.length > maxLength) {
    throw new Error(`Field ${field} exceeds ${maxLength} chars: ${text}`);
  }
  return text;
}

function optionalString(value, maxLength) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function requireHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`Invalid hours: ${value}`);
  return Math.round(hours * 10) / 10;
}

function normalizeRecord(row) {
  return {
    student_id: requireString(row.student_id, 'student_id', 32),
    student_name: requireString(row.student_name, 'student_name', 64),
    college: optionalString(normalizeCollegeName(row.college), 128),
    grade: optionalString(row.grade, 16),
    phone: optionalString(row.phone, 20),
    activity_name: requireString(row.activity_name, 'activity_name', 256),
    activity_date: requireString(row.activity_date, 'activity_date', 10),
    hours: requireHours(row.hours),
    activity_period: optionalString(row.activity_period, 64),
    source_file: optionalString(row.source_file, 256),
    source_sheet: optionalString(row.source_sheet, 128),
    source_row: row.source_row === null || row.source_row === undefined || row.source_row === ''
      ? null
      : Number(row.source_row),
    import_detail_status: optionalString(row.import_detail_status, 32),
    source_total_hours: row.source_total_hours === null || row.source_total_hours === undefined || row.source_total_hours === ''
      ? null
      : requireHours(row.source_total_hours),
  };
}

function loadPayload() {
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error('Payload must contain a records array');
  }

  const records = payload.records.map(normalizeRecord);
  if (records.length === 0) {
    throw new Error('Payload contains no records');
  }

  return {
    meta: payload.meta || {},
    records,
  };
}

function countSqlResult(result) {
  return Number(result.rows[0]?.count || 0);
}

async function deleteWithCount(client, sql, params = []) {
  const result = await client.query(sql, params);
  return countSqlResult(result);
}

async function clearRedisCache(summary) {
  if (!process.env.REDIS_URL) return;

  let createClient;
  try {
    ({ createClient } = require('redis'));
  } catch {
    summary.redis_cache = 'redis_package_missing';
    return;
  }

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    let cursor = '0';
    let deleted = 0;
    do {
      const scanResult = await redis.scan(cursor, { MATCH: 'query:*', COUNT: 500 });
      cursor = String(scanResult.cursor);
      const keys = scanResult.keys || [];
      if (keys.length > 0) {
        deleted += await redis.del(keys);
      }
    } while (cursor !== '0');
    summary.redis_query_keys_deleted = deleted;
  } catch (error) {
    summary.redis_cache = `clear_failed:${error.message}`;
  } finally {
    try {
      await redis.quit();
    } catch {
      // ignore cleanup failure
    }
  }
}

async function insertRecords(client, batchId, records) {
  const chunkSize = 500;
  let inserted = 0;

  for (let offset = 0; offset < records.length; offset += chunkSize) {
    const chunk = records.slice(offset, offset + chunkSize);
    const params = [];
    const values = chunk.map((record, index) => {
      const base = index * 18;
      params.push(
        record.student_id,
        record.student_name,
        record.college,
        record.grade,
        record.phone,
        record.activity_name,
        record.activity_date,
        record.hours,
        batchId,
        'imported',
        'approved',
        false,
        record.activity_period,
        record.source_file,
        record.source_sheet,
        record.source_row,
        record.import_detail_status,
        record.source_total_hours,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}::log_source, $${base + 11}::log_status, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18})`;
    });

    const result = await client.query(
      `
        INSERT INTO volunteer_logs (
          student_id, student_name, college, grade, phone,
          activity_name, activity_date, hours, import_batch_id,
          source, status, is_legacy_processed, activity_period,
          source_file, source_sheet, source_row, import_detail_status,
          source_total_hours
        )
        VALUES ${values.join(', ')}
        RETURNING id
      `,
      params,
    );
    inserted += result.rowCount;
  }

  return inserted;
}

async function main() {
  const { meta, records } = loadPayload();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const summary = {
    dry_run: dryRun,
    dataset_name: DATASET_NAME,
    payload_path: payloadPath,
    payload_meta: meta,
    payload_records: records.length,
  };

  try {
    await client.query('BEGIN');

    const admin = await client.query(
      "SELECT id, username FROM users WHERE username = 'admin' AND role = 'admin' LIMIT 1",
    );
    if (admin.rowCount === 0) {
      throw new Error('Admin user not found');
    }
    const adminId = admin.rows[0].id;

    const previousBatches = await client.query(
      `
        SELECT id
        FROM import_batches
        WHERE note = $1 OR filename = $2
      `,
      [DATASET_NAME, IMPORT_FILENAME],
    );
    const previousBatchIds = previousBatches.rows.map((row) => row.id);

    const testActivities = await client.query(
      "SELECT id FROM activities WHERE name LIKE '验收活动-%'",
    );
    const testActivityIds = testActivities.rows.map((row) => row.id);

    const testUsers = await client.query(
      "SELECT id FROM users WHERE username LIKE 'org\\_177705%' ESCAPE '\\' OR real_name = '验收组织者'",
    );
    const testUserIds = testUsers.rows.map((row) => row.id);

    summary.previous_batches = previousBatchIds.length;
    summary.test_activities = testActivityIds.length;
    summary.test_users = testUserIds.length;

    summary.operation_logs_deleted = await deleteWithCount(
      client,
      `
        WITH deleted AS (
          DELETE FROM operation_logs
          WHERE detail::text LIKE $1
             OR detail::text LIKE $2
             OR detail::text LIKE $3
             OR detail::text LIKE $4
             OR detail::text LIKE $5
             OR (action IN ('import.march_public_dataset', 'import.public_dataset') AND detail::text LIKE $1)
             OR ($6::uuid[] IS NOT NULL AND user_id = ANY($6::uuid[]))
             OR ($7::uuid[] IS NOT NULL AND target_id = ANY($7::uuid[]))
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `,
      [
        `%${DATASET_NAME}%`,
        '%177705%',
        '%测试学生%',
        '%导入学生%',
        '%验收活动%',
        testUserIds.length ? testUserIds : null,
        testActivityIds.length ? testActivityIds : null,
      ],
    );

    summary.volunteer_logs_deleted = await deleteWithCount(
      client,
      `
        WITH deleted AS (
          DELETE FROM volunteer_logs
          WHERE ($1::uuid[] IS NOT NULL AND import_batch_id = ANY($1::uuid[]))
             OR student_id LIKE 'T177705%'
             OR student_id LIKE 'I177705%'
             OR student_name LIKE '测试学生%'
             OR student_name LIKE '导入学生%'
             OR activity_name LIKE '验收活动-%'
             OR activity_name LIKE '导入验收活动-%'
             OR ($2::uuid[] IS NOT NULL AND activity_id = ANY($2::uuid[]))
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `,
      [previousBatchIds.length ? previousBatchIds : null, testActivityIds.length ? testActivityIds : null],
    );

    summary.import_batches_deleted = await deleteWithCount(
      client,
      `
        WITH deleted AS (
          DELETE FROM import_batches
          WHERE ($1::uuid[] IS NOT NULL AND id = ANY($1::uuid[]))
             OR note LIKE '验收导入-%'
             OR filename LIKE 'import-177705%.xlsx'
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `,
      [previousBatchIds.length ? previousBatchIds : null],
    );

    summary.activities_deleted = await deleteWithCount(
      client,
      `
        WITH deleted AS (
          DELETE FROM activities
          WHERE name LIKE '验收活动-%'
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `,
    );

    summary.users_deleted = await deleteWithCount(
      client,
      `
        WITH deleted AS (
          DELETE FROM users
          WHERE (username LIKE 'org\\_177705%' ESCAPE '\\' OR real_name = '验收组织者')
            AND username <> 'admin'
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted
      `,
    );

    const batch = await client.query(
      `
        INSERT INTO import_batches (filename, imported_by, record_count, note)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at
      `,
      [IMPORT_FILENAME, adminId, records.length, DATASET_NAME],
    );

    const batchId = batch.rows[0].id;
    summary.import_batch_id = batchId;
    summary.import_batch_created_at = batch.rows[0].created_at;
    summary.records_inserted = await insertRecords(client, batchId, records);

    await client.query(
      `
        INSERT INTO operation_logs (user_id, username, action, target_type, target_id, detail)
        VALUES ($1, 'admin', 'import.public_dataset', 'import_batch', $2, $3::jsonb)
      `,
      [
        adminId,
        batchId,
        JSON.stringify({
          dataset_name: DATASET_NAME,
          import_filename: IMPORT_FILENAME,
          payload_records: records.length,
          raw_records: meta.raw_records || meta.raw_student_rows,
          final_students: meta.final_students,
          duplicate_groups: meta.duplicate_groups,
          duplicate_rows_removed: meta.duplicate_rows_removed,
          invalid_rows: meta.invalid_rows,
          import_mode: meta.import_mode || 'summary',
          activity_date: meta.activity_date,
          activity_date_policy: meta.activity_date_policy,
          source_total_hours: meta.source_total_hours,
          output_total_hours: meta.output_total_hours,
          total_hours_match: meta.total_hours_match,
          parsed_activity_records: meta.parsed_activity_records,
          supplement_records: meta.supplement_records,
          summary_records: meta.summary_records,
          conflict_rows: meta.conflict_rows,
          final_by_file: meta.final_by_file,
        }),
      ],
    );

    const verification = await client.query(
      `
        SELECT
          COUNT(*)::int AS actual_log_count,
          COUNT(*) FILTER (WHERE source = 'imported')::int AS imported_count,
          COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
          COALESCE(SUM(hours), 0)::numeric(12,1)::text AS total_hours
        FROM volunteer_logs
        WHERE import_batch_id = $1
      `,
      [batchId],
    );
    summary.verification = verification.rows[0];

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

  if (!dryRun) {
    await clearRedisCache(summary);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
