-- 022_retention.sql — retention/lifecycle engine dedup tables
BEGIN;

-- Dedup table — prevents same dormant/winback/moment alert firing repeatedly
CREATE TABLE IF NOT EXISTS crm_retention_actions (
  id              bigserial PRIMARY KEY,
  customer_id     int NOT NULL,
  phone           varchar(32),
  action_kind     varchar(32) NOT NULL CHECK (action_kind IN (
    'dormant_warm', 'dormant_cold', 'dormant_dead',
    'winback', 'moment_birthday', 'moment_anniversary'
  )),
  reference_date  date,                    -- moment date or last_order date — for occasion-bound dedup
  conversation_id int REFERENCES crm_conversations(id) ON DELETE SET NULL,
  followup_id     bigint REFERENCES crm_followups(id) ON DELETE SET NULL,
  promo_code      varchar(64),             -- only for winback
  context         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_retention_dedup_idx
  ON crm_retention_actions (customer_id, action_kind, reference_date);
CREATE INDEX IF NOT EXISTS crm_retention_recent_idx
  ON crm_retention_actions (customer_id, created_at DESC);

COMMIT;
