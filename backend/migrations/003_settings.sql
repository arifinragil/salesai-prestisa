-- 003_settings.sql — key-value settings store for runtime tunables
BEGIN;

CREATE TABLE IF NOT EXISTS crm_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER
);

-- Seed defaults (only if not present)
INSERT INTO crm_settings (key, value)
SELECT 'daily_cost_cap_usd', '5'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm_settings WHERE key = 'daily_cost_cap_usd');

INSERT INTO crm_settings (key, value)
SELECT 'shadow_mode_default', 'false'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM crm_settings WHERE key = 'shadow_mode_default');

COMMIT;
