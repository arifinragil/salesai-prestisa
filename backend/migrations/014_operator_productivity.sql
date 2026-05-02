-- 014 — Operator productivity: tasks, internal comments, notifications, saved views.

CREATE TABLE IF NOT EXISTS crm_tasks (
  id              serial PRIMARY KEY,
  title           varchar(200) NOT NULL,
  body            text,
  conversation_id integer REFERENCES crm_conversations(id) ON DELETE SET NULL,
  owner_id        integer NOT NULL REFERENCES staff_users(id),
  created_by      integer NOT NULL REFERENCES staff_users(id),
  status          varchar(16) NOT NULL DEFAULT 'open',
  priority        varchar(8)  NOT NULL DEFAULT 'normal',
  due_at          timestamptz,
  reminder_sent_at timestamptz,
  overdue_sent_at  timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_tasks_owner_status_idx ON crm_tasks (owner_id, status, due_at);
CREATE INDEX IF NOT EXISTS crm_tasks_conv_idx ON crm_tasks (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_tasks_due_pending_idx ON crm_tasks (due_at)
  WHERE status IN ('open','in_progress') AND reminder_sent_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_internal_comments (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  staff_id        integer NOT NULL REFERENCES staff_users(id),
  body            text NOT NULL,
  mentions        integer[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_internal_comments_conv_idx ON crm_internal_comments (conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS crm_internal_comments_mention_idx ON crm_internal_comments USING GIN (mentions);

CREATE TABLE IF NOT EXISTS crm_notifications (
  id          serial PRIMARY KEY,
  staff_id    integer NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  kind        varchar(32) NOT NULL,
  title       varchar(200) NOT NULL,
  body        text,
  link        varchar(255),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_notifications_staff_unread_idx
  ON crm_notifications (staff_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_saved_views (
  id          serial PRIMARY KEY,
  staff_id    integer REFERENCES staff_users(id) ON DELETE CASCADE,
  scope       varchar(16) NOT NULL,
  name        varchar(80) NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_shared   boolean NOT NULL DEFAULT FALSE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (scope IN ('inbox', 'pipeline'))
);

CREATE INDEX IF NOT EXISTS crm_saved_views_staff_scope_idx ON crm_saved_views (staff_id, scope) WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_saved_views_shared_scope_idx ON crm_saved_views (scope) WHERE is_shared = TRUE;

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS telegram_chat_id varchar(40),
  ADD COLUMN IF NOT EXISTS telegram_token   varchar(64);

INSERT INTO crm_saved_views (staff_id, scope, name, filters, is_shared) VALUES
  (NULL, 'inbox', 'Belum diambil hari ini', '{"queue":"unassigned"}'::jsonb, TRUE),
  (NULL, 'inbox', 'VIP', '{"tag_name":"VIP"}'::jsonb, TRUE),
  (NULL, 'pipeline', 'Form sent stale', '{"stage":"form_dikirim"}'::jsonb, TRUE),
  (NULL, 'pipeline', 'High-value (wedding)', '{"type":"wedding"}'::jsonb, TRUE)
ON CONFLICT DO NOTHING;
