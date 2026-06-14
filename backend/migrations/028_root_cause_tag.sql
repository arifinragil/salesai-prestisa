-- 028_root_cause_tag.sql
-- Adds root_cause_tag columns to crm_lotus_state for Pareto analytics.

ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS root_cause_tag TEXT,
  ADD COLUMN IF NOT EXISTS root_cause_confidence NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS root_cause_tagged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS crm_lotus_state_root_cause_idx
  ON crm_lotus_state(root_cause_tag) WHERE root_cause_tag IS NOT NULL;
