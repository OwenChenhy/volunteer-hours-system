-- Additive mirror compatibility only. Preserve existing RLS and primary-database ownership.
ALTER TABLE public.volunteer_logs
  ADD COLUMN IF NOT EXISTS adjustment_reason VARCHAR(512),
  ADD COLUMN IF NOT EXISTS academic_year VARCHAR(9),
  ADD COLUMN IF NOT EXISTS academic_term VARCHAR(16),
  ADD COLUMN IF NOT EXISTS is_adjustment BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS academic_year VARCHAR(9),
  ADD COLUMN IF NOT EXISTS academic_term VARCHAR(16);
ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_academic_term_check;
ALTER TABLE public.activities ADD CONSTRAINT activities_academic_term_check CHECK (academic_term IS NULL OR academic_term IN ('upper', 'lower', 'vacation', 'unassigned'));
ALTER TABLE public.activities DROP CONSTRAINT IF EXISTS activities_academic_year_check;
ALTER TABLE public.activities ADD CONSTRAINT activities_academic_year_check CHECK (academic_year IS NULL OR (academic_year ~ '^20[0-9]{2}-20[0-9]{2}$' AND right(academic_year, 4)::integer = left(academic_year, 4)::integer + 1));
ALTER TABLE public.import_batches ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64);

ALTER TABLE public.volunteer_logs DROP CONSTRAINT IF EXISTS volunteer_logs_hours_check;
ALTER TABLE public.volunteer_logs ADD CONSTRAINT volunteer_logs_hours_check
  CHECK (hours >= 0 OR (hours >= -9999.9 AND is_adjustment AND length(trim(COALESCE(adjustment_reason, ''))) > 0));
ALTER TABLE public.volunteer_logs DROP CONSTRAINT IF EXISTS volunteer_logs_academic_term_check;
ALTER TABLE public.volunteer_logs ADD CONSTRAINT volunteer_logs_academic_term_check
  CHECK (academic_term IS NULL OR academic_term IN ('upper', 'lower', 'vacation', 'unassigned'));
ALTER TABLE public.volunteer_logs DROP CONSTRAINT IF EXISTS volunteer_logs_academic_year_check;
ALTER TABLE public.volunteer_logs ADD CONSTRAINT volunteer_logs_academic_year_check
  CHECK (academic_year IS NULL OR (academic_year ~ '^20[0-9]{2}-20[0-9]{2}$'
    AND right(academic_year, 4)::integer = left(academic_year, 4)::integer + 1));
CREATE INDEX IF NOT EXISTS idx_logs_academic ON public.volunteer_logs(academic_year, college, grade);
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_file_hash ON public.import_batches(file_hash) WHERE file_hash IS NOT NULL;


NOTIFY pgrst, 'reload schema';
