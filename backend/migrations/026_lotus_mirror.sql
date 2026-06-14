-- 026_lotus_mirror.sql
-- Mirror lotus_conversations → crm_conversations / crm_messages so all CRM
-- features (pipeline, supervisor, monitor, retention, etc.) automatically
-- see Lotus data alongside existing WAHA pilot data.
--
-- Keys:
--   crm_conversations.lotus_id    (NULL for WAHA convs, UNIQUE per-source)
--   crm_conversations.source      ('waha' | 'lotus')
--   crm_messages.lotus_msg_id     (NULL for WAHA msgs, UNIQUE per-source)
--   crm_messages.source           ('waha' | 'lotus')
-- The partial UNIQUE indexes ensure idempotent upsert without interfering
-- with existing WAHA-side waha_message_id uniqueness.

ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS source   VARCHAR(16) NOT NULL DEFAULT 'waha',
  ADD COLUMN IF NOT EXISTS lotus_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS crm_conv_lotus_id_uidx
  ON crm_conversations(lotus_id)
  WHERE lotus_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_conv_source_idx
  ON crm_conversations(source, last_message_at DESC NULLS LAST);

ALTER TABLE crm_messages
  ADD COLUMN IF NOT EXISTS source       VARCHAR(16) NOT NULL DEFAULT 'waha',
  ADD COLUMN IF NOT EXISTS lotus_msg_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS crm_msg_lotus_id_uidx
  ON crm_messages(lotus_msg_id)
  WHERE lotus_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_msg_source_idx
  ON crm_messages(source, conversation_id, created_at DESC);

-- Watermark / sync state
CREATE TABLE IF NOT EXISTS crm_lotus_sync_state (
  k          TEXT PRIMARY KEY,
  v          JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO crm_lotus_sync_state (k, v)
VALUES
  ('contacts', '{"ingested_at": "1970-01-01T00:00:00Z"}'),
  ('messages', '{"last_id": 0}')
ON CONFLICT (k) DO NOTHING;
