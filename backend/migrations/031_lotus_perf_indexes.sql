-- 031_lotus_perf_indexes.sql
-- Apply to lotus_conversations DB (not vonage_reports).
-- Supports analisa-lead filters: business_number + period + inbound count.

CREATE INDEX IF NOT EXISTS contacts_business_lastmsg_idx
  ON contacts(business_number, last_message_at);

CREATE INDEX IF NOT EXISTS messages_lotus_direction_idx
  ON messages(lotus_id, direction);
