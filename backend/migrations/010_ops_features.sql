-- 010 — Ops features: SLA, telegram, claims, KB drafts, AI corrections,
--       anomaly events, link funnel, spam blocks, presence.

-- staff_users: presence + display ergonomics
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS disabled_at  timestamptz;
CREATE INDEX IF NOT EXISTS staff_users_last_seen_idx ON staff_users (last_seen_at DESC NULLS LAST);

-- Conversation claim/lease — manual round-robin lock
CREATE TABLE IF NOT EXISTS crm_conversation_claims (
  conversation_id integer PRIMARY KEY REFERENCES crm_conversations(id) ON DELETE CASCADE,
  staff_id        integer NOT NULL REFERENCES staff_users(id),
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz
);
CREATE INDEX IF NOT EXISTS crm_conv_claims_staff_idx ON crm_conversation_claims (staff_id) WHERE released_at IS NULL;

-- KB draft kandidat dari low_confidence handover
CREATE TABLE IF NOT EXISTS crm_kb_drafts (
  id              serial PRIMARY KEY,
  conversation_id integer REFERENCES crm_conversations(id) ON DELETE SET NULL,
  message_id      integer,
  question        text NOT NULL,
  suggested_answer text,
  status          varchar(16) NOT NULL DEFAULT 'pending', -- pending|approved|dismissed
  approved_topic_id integer REFERENCES crm_kb_topics(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  reviewed_by     integer REFERENCES staff_users(id)
);
CREATE INDEX IF NOT EXISTS crm_kb_drafts_status_idx ON crm_kb_drafts (status, created_at DESC);

-- Operator correction logger — diff between AI suggested and operator-sent
CREATE TABLE IF NOT EXISTS crm_ai_corrections (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  staff_id        integer REFERENCES staff_users(id),
  ai_suggested    text NOT NULL,
  operator_sent   text NOT NULL,
  similarity      numeric(4,3),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_ai_corrections_created_idx ON crm_ai_corrections (created_at DESC);

-- Anomaly events history (for dashboard + de-dup)
CREATE TABLE IF NOT EXISTS crm_anomaly_events (
  id           serial PRIMARY KEY,
  kind         varchar(32) NOT NULL, -- complaint_spike|refund_spike|handover_spike|send_failed_spike
  metric_value numeric,
  threshold    numeric,
  window_label varchar(32),
  detail       text,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_anomaly_kind_idx ON crm_anomaly_events (kind, created_at DESC);

-- Order link funnel events (form_loaded, submitted, paid is in MySQL order)
CREATE TABLE IF NOT EXISTS crm_link_events (
  id              serial PRIMARY KEY,
  conversation_id integer REFERENCES crm_conversations(id) ON DELETE SET NULL,
  ref             varchar(64) NOT NULL,
  event           varchar(32) NOT NULL, -- click|form_loaded|submitted
  source_ip       inet,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_link_events_ref_idx ON crm_link_events (ref, event);

-- Spam block list (early-skip AI for known abusers)
CREATE TABLE IF NOT EXISTS crm_spam_blocks (
  id          serial PRIMARY KEY,
  phone       varchar(48) NOT NULL UNIQUE,
  reason      varchar(64),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

-- Seed default settings rows (idempotent)
INSERT INTO crm_settings (key, value) VALUES
  ('telegram_bot_token', '""'::jsonb),
  ('telegram_chat_id', '""'::jsonb),
  ('sla_handover_minutes', '15'::jsonb),
  ('daily_brief_enabled', 'true'::jsonb),
  ('daily_brief_time', '"09:00"'::jsonb),
  ('anomaly_alerts_enabled', 'true'::jsonb),
  ('claim_lease_minutes', '5'::jsonb),
  ('spam_filter_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
