-- 011 — growth: shifts, per-tag SLA, snippets, KB embeddings, facts,
--       health, audit log, escalation classifier, synthetic evals, delivery push.

-- Operator shift schedule (recurring weekly)
CREATE TABLE IF NOT EXISTS crm_shifts (
  id          serial PRIMARY KEY,
  staff_id    integer NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sun .. 6=Sat
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  active      boolean NOT NULL DEFAULT TRUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_shifts_staff_idx ON crm_shifts (staff_id, weekday);

-- Per-tag SLA override
ALTER TABLE crm_tags ADD COLUMN IF NOT EXISTS sla_minutes integer;

-- Operator-private snippets (separate from global reply_templates)
CREATE TABLE IF NOT EXISTS crm_operator_snippets (
  id          serial PRIMARY KEY,
  staff_id    integer NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  shortcut    varchar(32) NOT NULL,
  title       varchar(120),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, shortcut)
);

-- KB topic embeddings (semantic search). Stored as JSONB float[]; small KB OK.
ALTER TABLE crm_kb_topics ADD COLUMN IF NOT EXISTS embedding jsonb;
ALTER TABLE crm_kb_topics ADD COLUMN IF NOT EXISTS embedded_at timestamptz;
ALTER TABLE crm_kb_topics ADD COLUMN IF NOT EXISTS embedding_hash varchar(64);

-- Customer facts extracted from conversation (post-handover/close)
CREATE TABLE IF NOT EXISTS crm_customer_facts (
  id              serial PRIMARY KEY,
  conversation_id integer REFERENCES crm_conversations(id) ON DELETE CASCADE,
  customer_id     integer,
  fact_key        varchar(64) NOT NULL,  -- receiver_name|receiver_address|delivery_date|budget|preference
  fact_value      text NOT NULL,
  confidence      numeric(3,2),
  source_message_id integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_customer_facts_conv_idx ON crm_customer_facts (conversation_id, fact_key);
CREATE INDEX IF NOT EXISTS crm_customer_facts_cust_idx ON crm_customer_facts (customer_id) WHERE customer_id IS NOT NULL;

-- Customer health score cache (recomputed daily)
CREATE TABLE IF NOT EXISTS crm_customer_health (
  customer_id integer PRIMARY KEY,
  score       smallint NOT NULL,                -- 0..100
  band        varchar(16) NOT NULL,             -- vip|warm|cold|at_risk|new
  inputs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Settings audit log
CREATE TABLE IF NOT EXISTS crm_settings_audit (
  id         serial PRIMARY KEY,
  key        varchar(64) NOT NULL,
  old_value  jsonb,
  new_value  jsonb,
  staff_id   integer REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_settings_audit_key_idx ON crm_settings_audit (key, created_at DESC);

-- Escalation reason classifier output
ALTER TABLE crm_handovers ADD COLUMN IF NOT EXISTS escalation_class varchar(32);

-- Synthetic eval — pre-canned customer Q sets
CREATE TABLE IF NOT EXISTS crm_synthetic_questions (
  id         serial PRIMARY KEY,
  category   varchar(64),
  question   text NOT NULL,
  expected_intent varchar(32),
  active     boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_synthetic_eval_runs (
  id          serial PRIMARY KEY,
  question_id integer NOT NULL REFERENCES crm_synthetic_questions(id) ON DELETE CASCADE,
  ai_reply    text,
  intent      varchar(32),
  score       numeric(3,2),
  reasoning   text,
  ran_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_synth_runs_qid_idx ON crm_synthetic_eval_runs (question_id, ran_at DESC);

-- Delivery push tracking — one entry per outbound transactional msg per order
CREATE TABLE IF NOT EXISTS crm_delivery_pushes (
  id          serial PRIMARY KEY,
  order_id    integer NOT NULL,
  conversation_id integer REFERENCES crm_conversations(id) ON DELETE SET NULL,
  kind        varchar(32) NOT NULL,    -- paid_confirm|pre_delivery|post_delivery
  status      varchar(16) NOT NULL DEFAULT 'sent',
  body        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind)
);
