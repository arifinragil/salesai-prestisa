-- 021_lead_distribution.sql — lead distribution settings + audit
BEGIN;

INSERT INTO crm_settings (key, value) VALUES
  ('lead_distribution_mode', '"auto"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Audit table — tracks every assignment (auto + manual) for transparency.
CREATE TABLE IF NOT EXISTS crm_lead_assignments (
  id              bigserial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  staff_id        int REFERENCES staff_users(id) ON DELETE SET NULL,
  role            varchar(20),                                 -- 'acquisition' | 'retention' (or NULL on manual override)
  source          varchar(20) NOT NULL,                        -- 'auto' | 'manual' | 'reassign'
  customer_state  varchar(10),                                 -- 'new' | 'existing' (decision input)
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  assigned_by     int REFERENCES staff_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS crm_lead_assignments_conv_idx ON crm_lead_assignments (conversation_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS crm_lead_assignments_staff_idx ON crm_lead_assignments (staff_id, assigned_at DESC);

COMMIT;
