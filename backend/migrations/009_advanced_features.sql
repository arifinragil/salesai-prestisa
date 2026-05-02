-- 009_advanced_features.sql — kolom + tabel untuk fitur lanjutan
BEGIN;

-- #8 Snooze: operator parkir conv beberapa jam, muncul kembali otomatis
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS snoozed_by INTEGER;
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS snoozed_note TEXT;
CREATE INDEX IF NOT EXISTS crm_conv_snoozed_idx ON crm_conversations(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- #16 Detected language for multi-lang persona
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS detected_language VARCHAR(8);

-- #1 Order link tracking — UTM ref dari AI conv → MySQL order.utm_ref akan
-- di-match ke ref ini (kita simpan referensi yg dikirim per conv)
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS last_order_url_sent_at TIMESTAMPTZ;
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS last_order_url_ref VARCHAR(64);

-- #2/#3/#4 Followup queue — scheduled outbound nudges
CREATE TABLE IF NOT EXISTS crm_followups (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  kind            VARCHAR(32) NOT NULL,  -- 'order_url_pending' | 'unpaid_reminder' | 'recurring_event' | 'custom'
  scheduled_for   TIMESTAMPTZ NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'cancelled' | 'skipped'
  body_template   TEXT,
  context         JSONB,                 -- {order_id, ref, recipient_name, occasion, ...}
  created_at      TIMESTAMPTZ DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS crm_followups_due_idx ON crm_followups(scheduled_for)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS crm_followups_conv_idx ON crm_followups(conversation_id, kind);

-- #9 AI quality scores (LLM-as-judge sampling)
CREATE TABLE IF NOT EXISTS crm_ai_quality_scores (
  id              BIGSERIAL PRIMARY KEY,
  message_id      BIGINT NOT NULL REFERENCES crm_messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL,
  scored_at       TIMESTAMPTZ DEFAULT now(),
  judge_model     VARCHAR(64),
  relevance       SMALLINT,  -- 1-5
  tone            SMALLINT,  -- 1-5
  factual         SMALLINT,  -- 1-5
  overall         NUMERIC(3,2),
  reasoning       TEXT,
  context         JSONB
);
CREATE INDEX IF NOT EXISTS crm_aiq_at_idx ON crm_ai_quality_scores(scored_at DESC);
CREATE INDEX IF NOT EXISTS crm_aiq_overall_idx ON crm_ai_quality_scores(overall);

-- #12 Sentiment flags on messages (lightweight inline classifier)
ALTER TABLE crm_messages ADD COLUMN IF NOT EXISTS sentiment VARCHAR(16);
-- Values: 'angry' | 'frustrated' | 'positive' | 'neutral' | NULL

-- #14 PII redaction tracking
ALTER TABLE crm_messages ADD COLUMN IF NOT EXISTS pii_flags JSONB;
-- Example: {"nik": 1, "card": 0, "phone": 2}

-- #10 Topic auto-tag — link to crm_tags so it appears in inbox like manual tags
ALTER TABLE crm_conversation_tags ADD COLUMN IF NOT EXISTS auto_tagged BOOLEAN DEFAULT FALSE;

-- #7 Handover brief storage (per-handover auto-generated)
ALTER TABLE crm_handovers ADD COLUMN IF NOT EXISTS brief TEXT;

COMMIT;
