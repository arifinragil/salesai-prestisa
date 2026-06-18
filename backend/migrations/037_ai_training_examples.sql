-- 037_ai_training_examples.sql
-- Few-shot self-improving knowledge base for stuck-lead diagnosis.
CREATE TABLE IF NOT EXISTS crm_ai_training_examples (
  id BIGSERIAL PRIMARY KEY,
  case_pattern TEXT NOT NULL,
  category VARCHAR(64) NOT NULL,
  subtype  VARCHAR(96),
  analysis TEXT NOT NULL,
  suggested_action TEXT,
  suggested_script TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'manual_entry',
  source_action_id BIGINT,
  created_by INT REFERENCES staff_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  usage_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  CONSTRAINT chk_training_category CHECK (category IN ('customer','sales_handling','offer','process'))
);
CREATE INDEX IF NOT EXISTS idx_training_active_category
  ON crm_ai_training_examples (active, category, last_used_at DESC NULLS LAST);
