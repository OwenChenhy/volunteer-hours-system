-- Server-only, bounded uploads avoid sending the entire frozen library in one REST request.
CREATE OR REPLACE FUNCTION public.sync_publication_snapshot(
  p_id uuid, p_operation text, p_metadata jsonb DEFAULT NULL,
  p_field text DEFAULT NULL, p_chunk jsonb DEFAULT NULL, p_digest text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public
AS $$
DECLARE
  snapshot_value jsonb;
  expected_count integer;
  expected_hours numeric;
  actual_hours numeric;
  actual_digest text;
BEGIN
  IF p_operation = 'begin' THEN
    IF EXISTS (SELECT 1 FROM public.publication_state WHERE publication_id = p_id) THEN
      RAISE EXCEPTION 'Cannot replace the current publication';
    END IF;
    IF EXISTS (SELECT 1 FROM public.publication_batches WHERE id = p_id AND NOT COALESCE((snapshot->>'_uploading')::boolean, false)) THEN
      RAISE EXCEPTION 'Completed publications are immutable';
    END IF;
    INSERT INTO public.publication_batches(id, publication_month, label, source_revision,
      published_by, published_at, record_count, total_hours, snapshot)
    VALUES (p_id, p_metadata->>'publication_month', p_metadata->>'label',
      (p_metadata->>'source_revision')::bigint, (p_metadata->>'published_by')::uuid,
      (p_metadata->>'published_at')::timestamptz, (p_metadata->>'record_count')::integer,
      (p_metadata->>'total_hours')::numeric,
      jsonb_build_object('records','[]'::jsonb,'totals','[]'::jsonb,'rules',p_metadata->'rules','_uploading',true))
    ON CONFLICT(id) DO UPDATE SET snapshot = EXCLUDED.snapshot;
    RETURN jsonb_build_object('id',p_id,'uploading',true);
  END IF;

  SELECT snapshot, record_count, total_hours INTO snapshot_value, expected_count, expected_hours
  FROM public.publication_batches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication not found'; END IF;
  IF p_operation = 'verify' THEN
    RETURN jsonb_build_object('id',p_id,'digest',md5(snapshot_value::text),
      'records',jsonb_array_length(snapshot_value->'records'),
      'uploading',COALESCE((snapshot_value->>'_uploading')::boolean,false));
  END IF;
  IF NOT COALESCE((snapshot_value->>'_uploading')::boolean,false) THEN
    RAISE EXCEPTION 'Publication is already complete';
  END IF;
  IF p_operation = 'append' THEN
    IF p_field IS NULL OR p_field NOT IN ('records','totals') OR p_chunk IS NULL OR jsonb_typeof(p_chunk) <> 'array' OR
      jsonb_array_length(p_chunk) > 1000 OR octet_length(p_chunk::text) > 1048576 THEN
      RAISE EXCEPTION 'Invalid or oversized publication chunk';
    END IF;
    UPDATE public.publication_batches SET snapshot =
      jsonb_set(snapshot_value, ARRAY[p_field], (snapshot_value->p_field) || p_chunk)
      WHERE id=p_id;
    RETURN jsonb_build_object('id',p_id,'appended',jsonb_array_length(p_chunk));
  END IF;
  IF p_operation <> 'finish' THEN RAISE EXCEPTION 'Invalid operation'; END IF;
  snapshot_value = snapshot_value - '_uploading';
  actual_digest = md5(snapshot_value::text);
  SELECT COALESCE(sum((record->>'hours')::numeric),0) INTO actual_hours
    FROM jsonb_array_elements(snapshot_value->'records') AS record;
  IF jsonb_array_length(snapshot_value->'records') <> expected_count OR
    actual_hours <> expected_hours OR actual_digest IS DISTINCT FROM p_digest THEN
    RAISE EXCEPTION 'Publication count, hours or digest mismatch';
  END IF;
  UPDATE public.publication_batches SET snapshot = snapshot_value WHERE id = p_id;
  RETURN jsonb_build_object('id',p_id,'digest',actual_digest,'records',expected_count,'uploading',false);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_publication_snapshot(uuid,text,jsonb,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_publication_snapshot(uuid,text,jsonb,text,jsonb,text) TO service_role;
NOTIFY pgrst, 'reload schema';
