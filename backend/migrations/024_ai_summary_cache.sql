-- Cache last AI summary on conversation so panel can show it without re-generating
ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary_msg_count INTEGER,
  ADD COLUMN IF NOT EXISTS ai_summary_generated_at TIMESTAMPTZ;
