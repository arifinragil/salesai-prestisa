-- 017_hot_lead_alerts.sql — dedup table for unanswered hot-lead Telegram alerts
BEGIN;

CREATE TABLE IF NOT EXISTS crm_hot_lead_alerts (
  id              bigserial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  alert_kind      varchar(20) NOT NULL CHECK (alert_kind IN ('owner_3min', 'supervisor_5min')),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  inbound_msg_id  bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  staff_id        int REFERENCES staff_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS crm_hot_lead_alerts_dedup_idx
  ON crm_hot_lead_alerts (conversation_id, alert_kind, sent_at DESC);

COMMIT;
