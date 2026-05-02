-- 008_inbound_debounce.sql — debounce per-conversation burst messages
-- so AI waits ~10s and replies once for the whole burst.
BEGIN;

ALTER TABLE crm_inbound_queue
  ADD COLUMN IF NOT EXISTS process_after TIMESTAMPTZ NOT NULL DEFAULT now();

-- Allow 'skipped' status (rolled into a sibling job's batch)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'crm_inbound_queue' AND column_name = 'status'
  ) THEN
    NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS crm_inbound_queue_ready_idx
  ON crm_inbound_queue(process_after)
  WHERE status = 'pending';

COMMIT;
