-- 031_lotus_perf_indexes.sql
-- Apply to lotus_conversations DB (not vonage_reports).
-- Supports analisa-lead filters: business_number + period + inbound count.
-- NOTE: tables live in a separate DB; skip gracefully if not present here.

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS contacts_business_lastmsg_idx
    ON contacts(business_number, last_message_at);
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS messages_lotus_direction_idx
    ON messages(lotus_id, direction);
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;
