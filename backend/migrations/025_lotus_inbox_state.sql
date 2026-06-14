-- crm_lotus_state — keyed by lotus_id (from lotus_conversations.contacts.lotus_id).
-- Stores all CRM-side state for Lotus-source conversations without modifying
-- lotus_conversations tables (which are a read-only mongo mirror).
CREATE TABLE IF NOT EXISTS crm_lotus_state (
  lotus_id                text PRIMARY KEY,
  cust_number             text,
  assigned_staff_id       integer REFERENCES staff_users(id) ON DELETE SET NULL,
  ai_enabled              boolean        DEFAULT FALSE,
  ai_paused_until         timestamptz,
  snoozed_until           timestamptz,
  snoozed_by              integer REFERENCES staff_users(id) ON DELETE SET NULL,
  snoozed_note            text,
  shadow_mode             boolean        DEFAULT FALSE,
  status                  text           DEFAULT 'active',  -- active | closed | spam
  last_intent             text,
  lead_temperature        text,
  lead_score              integer,
  handover_count          integer        DEFAULT 0,
  customer_id             integer,
  first_inbound_at        timestamptz,
  first_response_at       timestamptz,
  ai_summary              text,
  ai_summary_msg_count    integer,
  ai_summary_generated_at timestamptz,
  created_at              timestamptz    DEFAULT now(),
  updated_at              timestamptz    DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_lotus_state_assigned_idx ON crm_lotus_state (assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_lotus_state_status_idx   ON crm_lotus_state (status);
CREATE INDEX IF NOT EXISTS crm_lotus_state_snoozed_idx  ON crm_lotus_state (snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_lotus_state_cust_idx     ON crm_lotus_state (cust_number);
