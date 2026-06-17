-- 030_sales_insight_cache.sql
-- 1-hour cache for Gemini narrative insights, keyed by filter combo hash.

CREATE TABLE IF NOT EXISTS crm_sales_insight_cache (
  cache_key      TEXT PRIMARY KEY,
  filter_payload JSONB NOT NULL,
  scope          TEXT NOT NULL,
  insight_text   TEXT NOT NULL,
  message_count  INTEGER,
  generated_at   TIMESTAMPTZ DEFAULT now(),
  expires_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS crm_sales_insight_cache_expires_idx
  ON crm_sales_insight_cache(expires_at);
