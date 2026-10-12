const db = require('../db');
const academic = require('./academicService');

const COLUMNS = 'id, student_id, student_name, college, grade, academic_year, academic_term, is_adjustment, activity_name, activity_date, activity_period, hours, source, import_detail_status, source_total_hours, created_at, status, reject_reason';
const key = (...values) => JSON.stringify(values);
let loaded, loading, checkedAt = 0, generation = 0;

function fingerprint(row) {
  return key(...COLUMNS.split(', ').map(field => {
    const value = row[field];
    return value instanceof Date ? value.toISOString() : field === 'hours' ? Number(value) : value ?? null;
  }));
}

function prepare(batch) {
  const people = new Map(), originals = new Map(), scopes = new Map();
  for (const row of batch.snapshot.records) {
    const identity = key(row.student_id, row.student_name);
    if (!people.has(identity)) people.set(identity, []);
    people.get(identity).push(row);
    originals.set(row.id, fingerprint(row));
  }
  // SQL orders the totals once. Filtering that order preserves ties and pagination in every scope.
  for (const row of batch.snapshot.totals) {
    for (const [college, grade] of [[null, null], [row.college || null, null], [null, row.grade || null], [row.college || null, row.grade || null]].filter((value, index, all) => all.findIndex(other => key(...other) === key(...value)) === index)) {
      const scope = key(row.academic_year, college, grade);
      if (!scopes.has(scope)) scopes.set(scope, []);
      scopes.get(scope).push(row);
    }
  }
  for (const [scope, rows] of scopes) {
    let rank = 0, previous;
    scopes.set(scope, rows.map(row => {
      if (row.total_hours !== previous) rank++;
      previous = row.total_hours;
      return { ...row, rank, total_students: rows.length };
    }));
  }
  return { batch, people, originals, scopes };
}

async function publish(userId, input, bootstrap = false) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(927642)');
    await client.query('LOCK TABLE volunteer_logs IN SHARE MODE');
    if (bootstrap) {
      const existing = await client.query('SELECT p.* FROM publication_state s JOIN publication_batches p ON p.id = s.publication_id WHERE s.id = true');
      if (existing.rows.length) { await client.query('COMMIT'); return prepare(existing.rows[0]); }
    } else {
      const pending = await client.query("SELECT count(*)::int AS count FROM volunteer_logs WHERE status = 'pending'");
      if (pending.rows[0].count) {
        const error = new Error(`还有 ${pending.rows[0].count} 条记录待审核，完成审核后才能统一发布`);
        error.statusCode = 409;
        throw error;
      }
    }
    const revision = (await client.query('SELECT revision FROM data_versions WHERE id = true')).rows[0].revision;
    const prior = await client.query('SELECT * FROM publication_batches WHERE publication_month = $1 AND source_revision = $2', [input.publication_month, revision]);
    let batch = prior.rows[0];
    if (!batch) {
      const expr = academic.expressions();
      const records = (await client.query(`SELECT ${COLUMNS}, ${expr.year} AS classified_year, ${expr.term} AS classified_term FROM volunteer_logs l WHERE status = 'approved' ORDER BY activity_date DESC, created_at DESC, id`)).rows;
      const totals = (await client.query(`WITH classified AS (
        SELECT student_id, student_name, college, grade, hours, ${expr.year} AS academic_year, ${expr.term} AS term
        FROM volunteer_logs l WHERE status = 'approved'
      ) SELECT academic_year, student_id, student_name, college, grade,
        COALESCE(SUM(hours) FILTER (WHERE term='upper'),0) AS upper_hours,
        COALESCE(SUM(hours) FILTER (WHERE term='lower'),0) AS lower_hours,
        COALESCE(SUM(hours) FILTER (WHERE term='vacation'),0) AS vacation_hours,
        COALESCE(SUM(hours) FILTER (WHERE term='unassigned'),0) AS unassigned_hours,
        SUM(hours) AS total_hours FROM classified
        GROUP BY academic_year, student_id, student_name, college, grade
        ORDER BY total_hours DESC, student_id, student_name, college, grade`)).rows.map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field, field.endsWith('_hours') ? Number(value) : value])));
      const totalHours = records.reduce((sum, row) => sum + Math.round(Number(row.hours) * 10), 0) / 10;
      const snapshot = { records, totals, rules: academic.rules() };
      batch = (await client.query(`INSERT INTO publication_batches(publication_month,label,source_revision,published_by,record_count,total_hours,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`, [input.publication_month, input.label, revision, userId, records.length, totalHours, JSON.stringify(snapshot)])).rows[0];
    }
    const ready = prepare(batch);
    await client.query('INSERT INTO publication_state(id,publication_id) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET publication_id=excluded.publication_id', [batch.id]);
    await client.query('COMMIT');
    generation++;
    loaded = ready;
    checkedAt = Date.now();
    return ready;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function current() {
  if (loaded && Date.now() - checkedAt < 1000) return loaded;
  if (!loading) loading = (async () => {
    const before = generation;
    let candidate = loaded;
    const state = await db.query('SELECT publication_id FROM publication_state WHERE id = true');
    if (!state.rows.length) {
      const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
      const month = `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
      candidate = await publish(null, { publication_month: month, label: '历史公示基线' }, true);
    } else if (loaded?.batch.id !== state.rows[0].publication_id) {
      candidate = prepare((await db.query('SELECT * FROM publication_batches WHERE id=$1', [state.rows[0].publication_id])).rows[0]);
    }
    if (generation === before) { loaded = candidate; checkedAt = Date.now(); }
    return loaded || candidate;
  })().finally(() => { loading = null; });
  return loading;
}

function meta(state) {
  const batch = state.batch;
  const email = String(process.env.FEEDBACK_EMAIL || '').trim();
  return { revision: `published:${batch.id}`, publication_id: batch.id, publication_month: batch.publication_month, source_name: batch.label, batch_id: batch.id, note: '审核完成后统一发布；未发布活动不计入正式时长和排名', record_count: batch.record_count, last_updated_at: batch.published_at, academic_rules: batch.snapshot.rules, feedback_email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null };
}

function summary(state, options) {
  if (!academic.validYear(options.academic_year)) throw new Error('学年必须为连续的 YYYY-YYYY');
  const all = state.scopes.get(key(options.academic_year, options.college || null, options.grade || null)) || [];
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 50)));
  const selected = options.student_id ? all.filter(row => row.student_id === options.student_id) : all;
  return { academic_year: options.academic_year, page, limit, total_students: all.length, rows: selected.slice((page - 1) * limit, page * limit).map(({ academic_year, ...row }) => row) };
}

async function progress(state, studentId, studentName) {
  const records = (await db.query(`SELECT ${COLUMNS} FROM volunteer_logs WHERE student_id=$1 AND student_name=$2 ORDER BY created_at DESC, id`, [studentId, studentName])).rows;
  return records.filter(row => state.originals.get(row.id) !== fingerprint(row)).map(row => ({ activity_name: row.activity_name, activity_date: row.activity_date, college: row.college, grade: row.grade, hours: Number(row.hours), status: row.status, status_label: row.status === 'approved' ? '审核通过，待统一发布' : row.status === 'rejected' ? '审核未通过' : '审核中', reject_reason: row.status === 'rejected' ? row.reject_reason : null }));
}

async function status() {
  const state = await current();
  const counts = await db.query("SELECT status, count(*)::int AS count FROM volunteer_logs GROUP BY status");
  const revision = (await db.query('SELECT revision FROM data_versions WHERE id=true')).rows[0].revision;
  const history = (await db.query('SELECT id,publication_month,label,published_at,record_count,total_hours FROM publication_batches ORDER BY published_at DESC LIMIT 12')).rows;
  return { published: meta(state), counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])), has_changes: String(revision) !== String(state.batch.source_revision), history };
}

module.exports = { current, publish, meta, summary, progress, status, identityKey: key };
