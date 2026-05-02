-- 015_copilot.sql — AI Co-Pilot mode + supervisor scoring + lead temperature
BEGIN;

-- ============ Phase 1 ============
INSERT INTO crm_settings (key, value)
VALUES ('ai_mode', '"auto"'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO crm_settings (key, value) VALUES
  ('first_response_sla_seconds', '60'::jsonb),
  ('followup_sop_minutes', '30'::jsonb),
  ('suggestion_deviation_threshold', '0.3'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE crm_reply_templates
  ADD COLUMN IF NOT EXISTS case_label   varchar(80),
  ADD COLUMN IF NOT EXISTS case_pattern text,
  ADD COLUMN IF NOT EXISTS intent_match varchar(32);

CREATE TABLE IF NOT EXISTS crm_suggestion_log (
  id              bigserial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  inbound_msg_id  bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  shown_at        timestamptz DEFAULT now(),
  options         jsonb NOT NULL,
  generation_ms   int,
  picked_rank     smallint,
  usage_type      varchar(10) CHECK (usage_type IN ('raw', 'edited', 'manual')),
  sent_msg_id     bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  staff_id        int REFERENCES staff_users(id) ON DELETE RESTRICT,
  pick_latency_ms int,
  edit_distance   numeric(4,3),
  flagged_reason  varchar(20),
  flagged_note    text,
  regen_count     smallint DEFAULT 0
);
CREATE INDEX IF NOT EXISTS crm_suggestion_log_conv_idx  ON crm_suggestion_log (conversation_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS crm_suggestion_log_staff_idx ON crm_suggestion_log (staff_id, shown_at DESC) WHERE staff_id IS NOT NULL;

-- ============ Phase 2 (lead temp) ============
ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS first_inbound_at  timestamptz,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS lead_temperature  varchar(8) DEFAULT 'cold'
    CHECK (lead_temperature IN ('hot', 'warm', 'cold')),
  ADD COLUMN IF NOT EXISTS lead_score        smallint;
CREATE INDEX IF NOT EXISTS crm_conv_lead_temp_idx ON crm_conversations (lead_temperature, last_message_at DESC);

-- ============ Phase 3 (scoring) ============
CREATE TABLE IF NOT EXISTS crm_agent_red_flags (
  id              bigserial PRIMARY KEY,
  staff_id        int NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  conversation_id int,
  rule_id         varchar(40) NOT NULL,
  severity        varchar(10) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  detail          jsonb,
  detected_at     timestamptz DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     int REFERENCES staff_users(id) ON DELETE SET NULL,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS crm_red_flags_staff_idx ON crm_agent_red_flags (staff_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS crm_red_flags_open_idx  ON crm_agent_red_flags (severity, resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_agent_daily_scores (
  staff_id              int NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  date                  date NOT NULL,
  conv_handled          int DEFAULT 0,
  msg_sent              int DEFAULT 0,
  avg_response_time_sec int,
  suggestion_shown      int DEFAULT 0,
  suggestion_used_raw   int DEFAULT 0,
  suggestion_used_edited int DEFAULT 0,
  suggestion_manual     int DEFAULT 0,
  avg_edit_distance     numeric(4,3),
  conv_closed_won       int DEFAULT 0,
  conv_closed_lost      int DEFAULT 0,
  total_value_won       numeric(14,2),
  conversion_rate       numeric(4,3),
  red_flags_high        int DEFAULT 0,
  red_flags_critical    int DEFAULT 0,
  csat_avg              numeric(3,2),
  csat_count            int DEFAULT 0,
  performance_score     numeric(5,2),
  computed_at           timestamptz DEFAULT now(),
  PRIMARY KEY (staff_id, date)
);

COMMIT;
