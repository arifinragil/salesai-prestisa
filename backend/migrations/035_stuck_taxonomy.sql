-- 035_stuck_taxonomy.sql
ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS stuck_group text,
  ADD COLUMN IF NOT EXISTS stuck_issue text;
