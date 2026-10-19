-- The primary performs and audits classification. The backup only mirrors its typed rows.
ALTER TABLE public.volunteer_logs ADD COLUMN IF NOT EXISTS record_kind VARCHAR(32) NOT NULL DEFAULT 'activity';
ALTER TABLE public.volunteer_logs ALTER COLUMN activity_name DROP NOT NULL;
NOTIFY pgrst, 'reload schema';
