-- 018_policy_blacklist.sql — settings for PII + policy keyword detection
BEGIN;

-- Default policy keyword blacklist (lowercase, JSON array). Editable via /admin later.
INSERT INTO crm_settings (key, value) VALUES
  ('policy_keyword_blacklist', '["refund pasti","100% refund","garansi seumur hidup","pasti untung","dijamin laku","money back"]'::jsonb),
  ('pii_extra_patterns', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
