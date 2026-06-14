-- 029_sales_identity.sql
-- Sales identity mapping: lotus assignee → canonical sales_key for analytics.

CREATE TABLE IF NOT EXISTS crm_sales_identity (
  sales_key       TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  brand           TEXT,
  lotus_user_id   INTEGER UNIQUE,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_sales_identity_brand_idx
  ON crm_sales_identity(brand) WHERE is_active;
