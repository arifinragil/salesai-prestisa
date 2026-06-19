-- 034_supervisor_control.sql
-- Supervisor Control Panel: catatan aksi supervisor + flag ack/resolve pada lead state.

CREATE TABLE IF NOT EXISTS crm_lead_supervisor_actions (
  id                   bigserial PRIMARY KEY,
  lotus_id             text NOT NULL,
  staff_id             int  NOT NULL,
  action               text NOT NULL,            -- ack | resolve | reassign | request_fu | revise_ai
  note                 text,
  corrected_root_cause text,                     -- diisi saat action='revise_ai'
  corrected_reason     text,                     -- diisi saat action='revise_ai'
  final_status         text,                     -- diisi saat action='revise_ai'
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_sup_actions_lotus
  ON crm_lead_supervisor_actions (lotus_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_sup_actions_revise
  ON crm_lead_supervisor_actions (action) WHERE action = 'revise_ai';

ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS supervisor_ack_at timestamptz,
  ADD COLUMN IF NOT EXISTS supervisor_ack_by int;
