ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'data_admin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'college_admin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'auditor';

CREATE TABLE IF NOT EXISTS review_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id UUID REFERENCES volunteer_logs(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  username VARCHAR(64),
  action VARCHAR(64) NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_notes_log_id ON review_notes(log_id);
CREATE INDEX IF NOT EXISTS idx_review_notes_created_at ON review_notes(created_at DESC);
