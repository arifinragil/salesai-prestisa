-- backend/migrations/033_analyst_report_columns.sql
-- Sales Performance Analyst v2 — Tier A structured output + Tier B markdown.
-- Backward compatible: kolom existing (root_cause_tag, ai_summary, ...) tidak diubah.

ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS lead_status                    TEXT,
  ADD COLUMN IF NOT EXISTS funnel_stage_lost              TEXT,
  ADD COLUMN IF NOT EXISTS customer_intent                TEXT,
  ADD COLUMN IF NOT EXISTS no_response_after              TEXT,
  ADD COLUMN IF NOT EXISTS controllability                TEXT,
  ADD COLUMN IF NOT EXISTS decision_maker                 TEXT,
  ADD COLUMN IF NOT EXISTS internal_root_cause_categories TEXT[],
  ADD COLUMN IF NOT EXISTS sales_handling                 JSONB,
  ADD COLUMN IF NOT EXISTS product_solution_fit           JSONB,
  ADD COLUMN IF NOT EXISTS confidence_v2                  TEXT,
  ADD COLUMN IF NOT EXISTS evidence_quote                 TEXT,
  ADD COLUMN IF NOT EXISTS analyst_report_generated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS analyst_report_msg_count       INT,
  ADD COLUMN IF NOT EXISTS analyst_summary_md             TEXT,
  ADD COLUMN IF NOT EXISTS analyst_summary_generated_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS crm_lotus_state_funnel_stage_idx
  ON crm_lotus_state (funnel_stage_lost) WHERE funnel_stage_lost IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_lotus_state_controllability_idx
  ON crm_lotus_state (controllability) WHERE controllability IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_lotus_state_internal_rc_gin_idx
  ON crm_lotus_state USING GIN (internal_root_cause_categories);
