-- 038_supervisor_review_fields.sql
-- Per-lead structured supervisor review state (drives Action Tracker + Daily Recap).
ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS supervisor_agree_with_ai BOOLEAN,
  ADD COLUMN IF NOT EXISTS supervisor_todo          TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_solved        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS supervisor_outcome       VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_lotus_state_review
  ON crm_lotus_state (supervisor_solved, supervisor_ack_at);
