-- Legacy dates were placeholders derived from semester columns, not occurrence dates.
-- Preserve created_at as the genuine import/audit timestamp; cleanup is a separate, backed-up operation.
ALTER TABLE volunteer_logs ALTER COLUMN activity_date DROP NOT NULL;
ALTER TABLE activities ALTER COLUMN start_time DROP NOT NULL;
ALTER TABLE activities ALTER COLUMN end_time DROP NOT NULL;
