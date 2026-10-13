ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TYPE log_status ADD VALUE IF NOT EXISTS 'withdrawn';
ALTER TYPE log_status ADD VALUE IF NOT EXISTS 'voided';
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_previous_status TEXT;
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_reason VARCHAR(512);
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_at TIMESTAMPTZ;
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_by UUID REFERENCES users(id);
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS submission_key VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_submission_key_student
ON volunteer_logs(submission_key, student_id) WHERE submission_key IS NOT NULL;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS dataset_key VARCHAR(160);
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
UPDATE import_batches SET dataset_key = CASE WHEN NULLIF(trim(note), '') IS NOT NULL
  THEN 'legacy:' || md5(trim(note)) ELSE 'legacy:' || id::text END WHERE dataset_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_import_dataset ON import_batches(dataset_key, created_at DESC);
ALTER TABLE volunteer_logs ADD COLUMN IF NOT EXISTS submission_hash VARCHAR(64);

DROP INDEX IF EXISTS public.idx_import_file_hash;
CREATE UNIQUE INDEX idx_import_file_hash ON public.import_batches(file_hash) WHERE file_hash IS NOT NULL AND superseded_at IS NULL;
