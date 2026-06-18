-- 039_lead_penyebab.sql
-- Per-lead "tidak closing" AI analysis (issue-tree taxonomy + structured analisa).
CREATE TABLE IF NOT EXISTS crm_lead_penyebab (
  id BIGSERIAL PRIMARY KEY,
  lotus_id TEXT UNIQUE NOT NULL,
  cust_number TEXT,
  business_number TEXT,
  is_closing BOOLEAN,
  churn BOOLEAN,
  issue TEXT,
  sub_issue TEXT,
  rinci TEXT,
  penyebab_tidak_closing TEXT,
  analisa JSONB,
  ai_model TEXT,
  ai_tokens_in INT,
  ai_tokens_out INT,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_penyebab_issue ON crm_lead_penyebab (issue, sub_issue);
CREATE INDEX IF NOT EXISTS idx_penyebab_analyzed ON crm_lead_penyebab (analyzed_at DESC);
