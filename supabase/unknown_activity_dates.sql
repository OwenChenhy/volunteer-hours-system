-- Mirror schema must accept the same unknown legacy dates as the primary database.
-- This changes nullability only; existing RLS and role grants remain intact.
ALTER TABLE public.volunteer_logs ALTER COLUMN activity_date DROP NOT NULL;
ALTER TABLE public.activities ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE public.activities ALTER COLUMN end_time DROP NOT NULL;
