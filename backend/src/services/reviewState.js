// A closure note is authoritative even when an older import did not update its legacy flag.
function reviewState(alias) {
  const raw = `COALESCE(${alias}.import_detail_status, 'normal')`;
  const archived = `EXISTS (SELECT 1 FROM review_notes rn WHERE rn.log_id=${alias}.id AND rn.action='archive_out_of_scope')`;
  const processed = `(COALESCE(${alias}.is_legacy_processed, false) OR ${raw} IN ('reviewed','archived_out_of_scope') OR EXISTS (
    SELECT 1 FROM review_notes rn WHERE rn.log_id=${alias}.id AND rn.action IN ('confirm_processed','archive_out_of_scope')))`;
  const type = `CASE WHEN ${raw} IN ('summary_conflict','summary_no_detail','supplement','reviewed','archived_out_of_scope') THEN
    CASE WHEN ${archived} THEN 'archived_out_of_scope' WHEN ${processed} THEN 'reviewed' ELSE ${raw} END ELSE ${raw} END`;
  const open = `(${alias}.source='imported' AND ${alias}.status IN ('pending','approved','rejected')
    AND ${raw} IN ('summary_conflict','summary_no_detail','supplement') AND NOT ${processed})`;
  return { processed, type, open };
}

module.exports = { reviewState };
