-- 023_b2b_outreach.sql — B2B sequenced outreach engine
BEGIN;

-- A campaign = named outreach with N sequence steps + filter snapshot
CREATE TABLE IF NOT EXISTS crm_b2b_campaigns (
  id              bigserial PRIMARY KEY,
  name            varchar(120) NOT NULL,
  status          varchar(16) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','paused','completed','cancelled')),
  filters         jsonb,                  -- snapshot of filters used to select prospects
  sequence        jsonb NOT NULL,         -- [{delay_days, body_template}, ...]
  created_by      int REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  launched_at     timestamptz,
  completed_at    timestamptz,
  notes           text
);

-- One row per (campaign × prospect), tracks sequence progress
CREATE TABLE IF NOT EXISTS crm_b2b_prospects (
  id              bigserial PRIMARY KEY,
  campaign_id     bigint NOT NULL REFERENCES crm_b2b_campaigns(id) ON DELETE CASCADE,
  customer_id     int,                    -- MySQL prestisa.customer.id (nullable for CSV imports without match)
  customer_name   varchar(200),
  phone           varchar(32) NOT NULL,
  conversation_id int REFERENCES crm_conversations(id) ON DELETE SET NULL,
  current_step    smallint NOT NULL DEFAULT 0,        -- 0 = not yet sent step #1
  status          varchar(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','replied','opted_out','completed','failed')),
  next_step_at    timestamptz,
  last_step_at    timestamptz,
  reply_at        timestamptz,
  context         jsonb,                  -- preview data (last_order_at, total_spent, etc.)
  added_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_b2b_prospects_unique_idx ON crm_b2b_prospects (campaign_id, phone);
CREATE INDEX IF NOT EXISTS crm_b2b_prospects_due_idx ON crm_b2b_prospects (next_step_at)
  WHERE status IN ('pending','in_progress');

-- Audit log per step delivery
CREATE TABLE IF NOT EXISTS crm_b2b_step_log (
  id              bigserial PRIMARY KEY,
  prospect_id     bigint NOT NULL REFERENCES crm_b2b_prospects(id) ON DELETE CASCADE,
  step_index      smallint NOT NULL,
  followup_id     bigint REFERENCES crm_followups(id) ON DELETE SET NULL,
  scheduled_for   timestamptz,
  result          varchar(16),            -- 'queued' | 'sent' | 'cancel:opted_out' | 'cancel:replied'
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_b2b_step_log_prospect_idx ON crm_b2b_step_log (prospect_id, step_index);

COMMIT;
