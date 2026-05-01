-- 004_wa_session.sql — track which WAHA session received each conversation
-- so the operator inbox can filter by phone number / persona.

BEGIN;

ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS wa_session VARCHAR(64);

CREATE INDEX IF NOT EXISTS crm_conv_wa_session_idx
  ON crm_conversations(wa_session, last_message_at DESC);

-- Backfill existing rows with the env default if any
UPDATE crm_conversations
SET wa_session = COALESCE(wa_session, 'finance0000')
WHERE wa_session IS NULL;

COMMIT;
