-- Review and apply before the next mirror sync. This migration does not change RLS.
BEGIN;
DO $$
DECLARE status_type text; kind "char"; status_column smallint; item record;
BEGIN
  SELECT format_type(a.atttypid,a.atttypmod),t.typtype,a.attnum
    INTO status_type,kind,status_column
    FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
    WHERE a.attrelid='public.volunteer_logs'::regclass AND a.attname='status' AND NOT a.attisdropped;
  IF kind='e' THEN
    EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L',status_type,'withdrawn');
    EXECUTE format('ALTER TYPE %s ADD VALUE IF NOT EXISTS %L',status_type,'voided');
  ELSIF kind='b' AND status_type IN ('text','character varying','character varying(16)','character varying(32)','character varying(64)') THEN
    -- Replace status-only checks; retain checks involving hours or other columns.
    FOR item IN SELECT conname FROM pg_constraint
      WHERE conrelid='public.volunteer_logs'::regclass AND contype='c' AND conkey=ARRAY[status_column]
    LOOP
      EXECUTE format('ALTER TABLE public.volunteer_logs DROP CONSTRAINT %I',item.conname);
    END LOOP;
    ALTER TABLE public.volunteer_logs ADD CONSTRAINT volunteer_logs_status_check
      CHECK(status IN ('pending','approved','rejected','withdrawn','voided'));
  ELSE
    RAISE EXCEPTION 'Unsupported mirror status type: %; inspect before changing its constraints',status_type;
  END IF;
END $$;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.activities ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_previous_status TEXT;
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_reason VARCHAR(512);
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_at TIMESTAMPTZ;
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS lifecycle_by UUID REFERENCES public.users(id);
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS submission_key VARCHAR(64);
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS submission_hash VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_submission_key_student
  ON public.volunteer_logs(submission_key,student_id) WHERE submission_key IS NOT NULL;
ALTER TABLE public.import_batches ADD COLUMN IF NOT EXISTS dataset_key VARCHAR(160);
ALTER TABLE public.import_batches ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
UPDATE public.import_batches SET dataset_key=CASE WHEN NULLIF(trim(note),'') IS NOT NULL
  THEN 'legacy:'||md5(trim(note)) ELSE 'legacy:'||id::text END WHERE dataset_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_import_dataset ON public.import_batches(dataset_key,created_at DESC);

DROP INDEX IF EXISTS public.idx_import_file_hash;
CREATE UNIQUE INDEX idx_import_file_hash ON public.import_batches(file_hash) WHERE file_hash IS NOT NULL AND superseded_at IS NULL;
NOTIFY pgrst,'reload schema';
COMMIT;
