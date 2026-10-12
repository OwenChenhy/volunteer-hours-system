CREATE TABLE IF NOT EXISTS publication_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_month VARCHAR(7) NOT NULL CHECK (publication_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  label VARCHAR(128) NOT NULL,
  source_revision BIGINT NOT NULL,
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL,
  total_hours NUMERIC NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE (publication_month, source_revision)
);
CREATE TABLE IF NOT EXISTS publication_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  publication_id UUID NOT NULL REFERENCES publication_batches(id)
);
