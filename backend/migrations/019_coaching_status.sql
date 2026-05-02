-- 019_coaching_status.sql — supervisor coach mode tags per agent
BEGIN;

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS coaching_status varchar(32)
    CHECK (coaching_status IN ('one_on_one_scheduled','remediation','probation') OR coaching_status IS NULL),
  ADD COLUMN IF NOT EXISTS coaching_note text,
  ADD COLUMN IF NOT EXISTS coaching_set_at  timestamptz,
  ADD COLUMN IF NOT EXISTS coaching_set_by  int REFERENCES staff_users(id) ON DELETE SET NULL;

COMMIT;
