-- 036_qna_vector.sql
CREATE TABLE IF NOT EXISTS crm_qna (
  id            bigserial PRIMARY KEY,
  question      text NOT NULL,
  answer        text NOT NULL,
  intent        text,
  business_number text,
  source        text NOT NULL DEFAULT 'curated',
  embedding     jsonb,
  embedding_hash text,
  enabled       boolean NOT NULL DEFAULT true,
  win_count     int NOT NULL DEFAULT 0,
  times_served  int NOT NULL DEFAULT 0,
  created_by    int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_qna_enabled_idx ON crm_qna (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS crm_qna_intent_idx  ON crm_qna (intent);

CREATE TABLE IF NOT EXISTS crm_lotus_suggestion_log (
  id            bigserial PRIMARY KEY,
  lotus_id      text NOT NULL,
  cust_number   text,
  shown_at      timestamptz NOT NULL DEFAULT now(),
  options       jsonb NOT NULL,
  picked_rank   smallint,
  usage_type    varchar(10) CHECK (usage_type IN ('raw','edited','manual')),
  edit_distance numeric(4,3),
  staff_id      int,
  flagged_reason varchar(20),
  flagged_note  text
);
CREATE INDEX IF NOT EXISTS crm_lotus_sug_log_idx ON crm_lotus_suggestion_log (lotus_id, shown_at DESC);
