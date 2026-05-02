-- 013 — Sales pipeline foundations.

-- Extend crm_conversations
ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS pipeline_stage varchar(32) NOT NULL DEFAULT 'baru',
  ADD COLUMN IF NOT EXISTS pipeline_stage_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS pipeline_type varchar(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS deal_value_idr bigint,
  ADD COLUMN IF NOT EXISTS deal_value_locked boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deal_order_id integer,
  ADD COLUMN IF NOT EXISTS lost_reason varchar(32),
  ADD COLUMN IF NOT EXISTS lost_note text,
  ADD COLUMN IF NOT EXISTS manual_stage_override boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pipeline_stage_history jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS crm_conv_pipeline_stage_idx
  ON crm_conversations (pipeline_stage, pipeline_stage_at DESC);
CREATE INDEX IF NOT EXISTS crm_conv_pipeline_type_idx
  ON crm_conversations (pipeline_type)
  WHERE pipeline_stage NOT IN ('delivered','lost');
CREATE INDEX IF NOT EXISTS crm_conv_deal_order_idx
  ON crm_conversations (deal_order_id) WHERE deal_order_id IS NOT NULL;

-- Extend crm_tags with pipeline_type mapping
ALTER TABLE crm_tags
  ADD COLUMN IF NOT EXISTS maps_to_pipeline_type varchar(16);

-- Audit trail: pipeline events
CREATE TABLE IF NOT EXISTS crm_pipeline_events (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  from_stage      varchar(32),
  to_stage        varchar(32) NOT NULL,
  source          varchar(48) NOT NULL,
  staff_id        integer REFERENCES staff_users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_pipeline_events_conv_idx
  ON crm_pipeline_events (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS crm_pipeline_events_stage_idx
  ON crm_pipeline_events (to_stage, created_at DESC);
