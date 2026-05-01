-- 001_init.sql — Tiara pilot schema
-- All tables prefixed crm_* in vonage_reports DB.
-- Idempotent (CREATE TABLE IF NOT EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS crm_migrations (
  id          SERIAL PRIMARY KEY,
  filename    VARCHAR(128) NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_conversations (
  id                SERIAL PRIMARY KEY,
  phone             VARCHAR(32) NOT NULL UNIQUE,
  customer_id       INTEGER,
  ai_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  ai_paused_until   TIMESTAMPTZ,
  assigned_staff_id INTEGER,
  status            VARCHAR(16) NOT NULL DEFAULT 'active',
  last_message_at   TIMESTAMPTZ,
  last_intent       VARCHAR(32),
  handover_count    INTEGER NOT NULL DEFAULT 0,
  shadow_mode       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_conv_status_idx
  ON crm_conversations(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS crm_conv_assigned_idx
  ON crm_conversations(assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_messages (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  direction         VARCHAR(8) NOT NULL,
  sender_type       VARCHAR(16) NOT NULL,
  staff_id          INTEGER,
  waha_message_id   VARCHAR(128) UNIQUE,
  body              TEXT,
  message_type      VARCHAR(20) DEFAULT 'text',
  attachment_url    TEXT,
  ai_metadata       JSONB,
  shadow            BOOLEAN NOT NULL DEFAULT FALSE,
  send_status       VARCHAR(16),
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_msg_conv_idx ON crm_messages(conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS crm_msg_created_idx ON crm_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS crm_inbound_queue (
  id                BIGSERIAL PRIMARY KEY,
  message_id        BIGINT NOT NULL REFERENCES crm_messages(id) ON DELETE CASCADE,
  conversation_id   INTEGER NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts          INTEGER NOT NULL DEFAULT 0,
  locked_at         TIMESTAMPTZ,
  locked_by         VARCHAR(64),
  error             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS crm_queue_pending_idx
  ON crm_inbound_queue(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS crm_queue_stale_idx
  ON crm_inbound_queue(locked_at) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS crm_handovers (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL,
  message_id        BIGINT,
  reason            VARCHAR(64) NOT NULL,
  detail            TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_handover_unresolved_idx
  ON crm_handovers(created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_handover_conv_idx
  ON crm_handovers(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_ai_metrics_daily (
  date              DATE PRIMARY KEY,
  total_inbound     INTEGER NOT NULL DEFAULT 0,
  total_ai_sent     INTEGER NOT NULL DEFAULT 0,
  total_handovers   INTEGER NOT NULL DEFAULT 0,
  unique_conversations INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms    INTEGER,
  total_tokens_in   BIGINT NOT NULL DEFAULT 0,
  total_tokens_out  BIGINT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  handover_breakdown JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_persona_prompts (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(64) NOT NULL,
  prompt_text       TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_persona_active_idx
  ON crm_persona_prompts(active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS crm_promo_settings (
  id                SERIAL PRIMARY KEY,
  code              VARCHAR(64) UNIQUE,
  description       TEXT,
  product_category  VARCHAR(64),
  city              VARCHAR(64),
  discount_pct      NUMERIC(5,2),
  discount_amount   NUMERIC(12,2),
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_promo_active_idx
  ON crm_promo_settings(active, ends_at) WHERE active = TRUE;

COMMIT;
