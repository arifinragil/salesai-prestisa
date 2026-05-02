-- 020_kb_draft_clustering.sql — cluster duplicate KB question drafts + auto-draft answers
BEGIN;

ALTER TABLE crm_kb_drafts
  ADD COLUMN IF NOT EXISTS frequency  int DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cluster_id int,
  ADD COLUMN IF NOT EXISTS embedding  jsonb,
  ADD COLUMN IF NOT EXISTS auto_drafted_at timestamptz;

CREATE INDEX IF NOT EXISTS crm_kb_drafts_cluster_idx ON crm_kb_drafts (cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_kb_drafts_pending_freq_idx ON crm_kb_drafts (frequency DESC) WHERE status = 'pending';

COMMIT;
