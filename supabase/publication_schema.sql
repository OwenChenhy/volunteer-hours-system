CREATE TABLE IF NOT EXISTS public.publication_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_month VARCHAR(7) NOT NULL CHECK (publication_month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  label VARCHAR(128) NOT NULL,
  source_revision BIGINT NOT NULL,
  published_by UUID REFERENCES public.users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  record_count INTEGER NOT NULL,
  total_hours NUMERIC NOT NULL,
  snapshot JSONB NOT NULL,
  UNIQUE(publication_month,source_revision)
);
CREATE TABLE IF NOT EXISTS public.publication_state (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id),
  publication_id UUID NOT NULL REFERENCES public.publication_batches(id)
);
ALTER TABLE public.publication_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publication_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publication_batches, public.publication_state FROM anon, authenticated;
GRANT ALL ON public.publication_batches, public.publication_state TO service_role;
CREATE POLICY service_role_all_publication_batches ON public.publication_batches FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE POLICY service_role_all_publication_state ON public.publication_state FOR ALL TO service_role USING(true) WITH CHECK(true);
-- Only the trusted mirror uploader needs enough time to store the cumulative snapshot.
ALTER ROLE service_role SET statement_timeout = '60s';
NOTIFY pgrst, 'reload config';
