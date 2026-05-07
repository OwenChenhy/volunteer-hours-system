ALTER TABLE volunteer_logs
  ADD COLUMN IF NOT EXISTS activity_period VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_file VARCHAR(256),
  ADD COLUMN IF NOT EXISTS source_sheet VARCHAR(128),
  ADD COLUMN IF NOT EXISTS source_row INTEGER,
  ADD COLUMN IF NOT EXISTS import_detail_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS source_total_hours NUMERIC(8,1);

CREATE INDEX IF NOT EXISTS idx_logs_activity_period ON volunteer_logs(activity_period);
CREATE INDEX IF NOT EXISTS idx_logs_import_source_row ON volunteer_logs(source_file, source_sheet, source_row);
