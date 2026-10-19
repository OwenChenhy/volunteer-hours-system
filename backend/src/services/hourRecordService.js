// Older frozen publications predate record_kind. Interpret their typed import marker
// without rewriting the immutable snapshot or turning its balance into an activity.
function isHistoricalBalance(row) {
  return ['historical_balance','historical_cumulative'].includes(row.record_kind) || (!row.record_kind && row.source === 'imported'
    && (row.import_detail_status === 'cumulative_reconciliation' && row.is_adjustment
      || row.activity_name === '累计时长记录' && ['summary_conflict','summary_no_detail','unresolved_balance'].includes(row.import_detail_status)));
}
function normalizeRecord(row) {
  return isHistoricalBalance(row) ? { ...row, record_kind: row.record_kind || (row.import_detail_status==='cumulative_reconciliation'?'historical_balance':'historical_cumulative'),
    activity_name: null, activity_id: null, activity_date: null,activity_period: null,academic_year: null,academic_term: null }
    : { ...row, record_kind: row.record_kind || 'activity' };
}
function historicalBalance(row) {
  return { id: row.id, record_kind: normalizeRecord(row).record_kind, hours: Number(row.hours),
    source_total_hours: Number(row.source_total_hours), imported_at: row.created_at };
}
module.exports = { isHistoricalBalance, normalizeRecord, historicalBalance };
