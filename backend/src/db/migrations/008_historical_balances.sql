-- A cumulative transcript difference is a ledger balance, never an activity.
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS record_kind VARCHAR(32) NOT NULL DEFAULT 'activity';
ALTER TABLE volunteer_logs ALTER COLUMN activity_name DROP NOT NULL;
ALTER TABLE volunteer_logs DROP CONSTRAINT IF EXISTS volunteer_logs_record_kind_check;
DO $$
DECLARE originals JSONB; placeholders JSONB;
BEGIN
  IF EXISTS (SELECT 1 FROM volunteer_logs WHERE record_kind='activity' AND activity_name='累计时长记录'
      AND source='imported' AND import_detail_status IN('summary_conflict','summary_no_detail','unresolved_balance')) THEN
    SELECT jsonb_agg(to_jsonb(l)) INTO originals FROM volunteer_logs l WHERE record_kind='activity'
      AND activity_name='累计时长记录' AND source='imported' AND import_detail_status IN('summary_conflict','summary_no_detail','unresolved_balance');
    SELECT jsonb_agg(to_jsonb(a)) INTO placeholders FROM activities a WHERE a.name='累计时长记录'
      AND a.id IN(SELECT (r->>'activity_id')::uuid FROM jsonb_array_elements(originals)r);
    INSERT INTO operation_logs(action,target_type,detail) VALUES('hours.classify_legacy_cumulative','historical_ledger',
      jsonb_build_object('reason','Cumulative source values are not activities; original rows and placeholder activities retained here for audit',
        'original_records',originals,'original_activities',COALESCE(placeholders,'[]'::jsonb)));
    UPDATE volunteer_logs SET record_kind='historical_cumulative',activity_name=NULL,activity_id=NULL,
      activity_date=NULL,activity_period=NULL,academic_year=NULL,academic_term=NULL
      WHERE id IN(SELECT (r->>'id')::uuid FROM jsonb_array_elements(originals)r);
    DELETE FROM activities a WHERE a.id IN(SELECT (r->>'id')::uuid FROM jsonb_array_elements(COALESCE(placeholders,'[]'::jsonb))r)
      AND NOT EXISTS(SELECT 1 FROM volunteer_logs l WHERE l.activity_id=a.id);
  END IF;
  IF EXISTS (SELECT 1 FROM volunteer_logs WHERE import_detail_status='cumulative_reconciliation' AND record_kind='activity') THEN
    UPDATE volunteer_logs SET record_kind='historical_balance', activity_name=NULL
    WHERE import_detail_status='cumulative_reconciliation' AND record_kind='activity'
      AND source='imported' AND is_adjustment AND activity_id IS NULL AND activity_date IS NULL
      AND academic_year IS NULL AND academic_term IS NULL AND activity_period IS NULL
      AND source_total_hours IS NOT NULL AND source_total_hours>=0 AND length(btrim(COALESCE(adjustment_reason,'')))>0;
  END IF;
    ALTER TABLE volunteer_logs ADD CONSTRAINT volunteer_logs_record_kind_check CHECK (
      (record_kind='activity' AND activity_name IS NOT NULL AND length(btrim(activity_name))>0
        AND import_detail_status IS DISTINCT FROM 'cumulative_reconciliation'
        AND NOT (activity_name='累计时长记录' AND COALESCE(import_detail_status,'') IN('summary_conflict','summary_no_detail','unresolved_balance'))) OR
      (record_kind IN('historical_balance','historical_cumulative') AND activity_name IS NULL AND activity_id IS NULL
        AND activity_date IS NULL AND activity_period IS NULL AND academic_year IS NULL AND academic_term IS NULL
        AND source='imported' AND import_batch_id IS NOT NULL AND source_total_hours IS NOT NULL AND source_total_hours>=0
        AND (record_kind='historical_cumulative' AND hours>=0 OR record_kind='historical_balance'
          AND is_adjustment AND length(btrim(COALESCE(adjustment_reason,'')))>0))
    );
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_historical_ledger_source
  ON volunteer_logs(import_batch_id,student_id,student_name,record_kind) WHERE record_kind IN('historical_balance','historical_cumulative');
