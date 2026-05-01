-- 006_real_phone.sql — operator-entered real phone for LID-locked conversations
BEGIN;

ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS real_phone VARCHAR(32),
  ADD COLUMN IF NOT EXISTS push_name  VARCHAR(150);

CREATE INDEX IF NOT EXISTS crm_conv_real_phone_idx ON crm_conversations(real_phone);

COMMIT;
