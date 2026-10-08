CREATE TABLE IF NOT EXISTS public_counters (
  name VARCHAR(64) PRIMARY KEY,
  value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public_counters (name, value)
VALUES ('query_page_visits', 0), ('student_queries', 0)
ON CONFLICT (name) DO NOTHING;
