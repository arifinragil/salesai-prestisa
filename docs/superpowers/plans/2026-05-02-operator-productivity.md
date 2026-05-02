# Operator Productivity Suite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tasks/reminders, internal comments + @mention, bulk actions, and saved views to Tiara CRM operator workflow.

**Architecture:** 4 new tables (`crm_tasks`, `crm_internal_comments`, `crm_notifications`, `crm_saved_views`) + extend `staff_users` (telegram_chat_id). Pure-function services + routes mounted under `/api/{tasks,notifications,saved-views,inbox,pipeline}`. Frontend: new `/tasks` page, NotificationsBell in Layout, InternalCommentsBlock in chat detail, BulkActionsToolbar extension, SavedViewsDropdown.

**Tech Stack:** Node 20 + Express 5 + PostgreSQL + Jest + Next.js 14 + Tailwind + SWR.

**Reference patterns to mirror:**
- `backend/services/pipelineEngine.js` — pure function service pattern
- `backend/routes/users.js` — REST endpoints with requireStaff
- `frontend/src/components/PipelineBoard.jsx` — interactive component pattern
- `frontend/src/pages/snippets.js` — list+CRUD page pattern

**Conventions:**
- CommonJS backend, ES modules frontend
- Conventional Commits per task
- Frequent commits, never broken tests
- Tailwind utility classes only

---

## Task 1: Migration 014 — schema

**Files:**
- Create: `backend/migrations/014_operator_productivity.sql`

- [ ] **Step 1.1: Write migration SQL**

```sql
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

-- Seed default shared views
INSERT INTO crm_saved_views (staff_id, scope, name, filters, is_shared) VALUES
  (NULL, 'inbox', 'Belum diambil hari ini', '{"queue":"unassigned"}'::jsonb, TRUE),
  (NULL, 'inbox', 'VIP', '{"tag_name":"VIP"}'::jsonb, TRUE),
  (NULL, 'pipeline', 'Form sent stale >24h', '{"stage":"form_dikirim"}'::jsonb, TRUE),
  (NULL, 'pipeline', 'High-value (wedding/b2b)', '{"type":"wedding"}'::jsonb, TRUE)
ON CONFLICT DO NOTHING;
```

- [ ] **Step 1.2: Apply + verify**

```bash
cd backend && /usr/bin/node db/migrate.js
```

Verify 4 tables created + staff_users has telegram_chat_id column.

- [ ] **Step 1.3: Commit**

---

## Task 2: tasksService + tests

**Files:**
- Create: `backend/services/tasksService.js`
- Create: `backend/__tests__/tasksService.test.js`

Services:
- `create(client, {title, body, conversation_id, owner_id, created_by, due_at, priority})` → returns task
- `setStatus(client, id, status, opts)` → returns updated task; valid transitions guarded
- `snooze(client, id, hours)` → push due_at + clear reminder_sent_at
- `listForOwner(client, ownerId, opts)` → with status/due filters
- `listForConv(client, convId)` → for chat detail panel

Status transitions table-driven (4×4 matrix).

Tests cover happy path + invalid transitions.

---

## Task 3: notificationsService + routes

**Files:**
- Create: `backend/services/notificationsService.js`
- Create: `backend/__tests__/notificationsService.test.js`

Functions:
- `notify(staffId, kind, title, body, link, payload)` → insert row
- `markRead(id, staffId)` (own only)
- `markAllRead(staffId)`
- `unreadCount(staffId)`
- `list(staffId, {limit, unreadOnly})`

Mount under `routes/notifications.js`:
- `GET /api/users/me/notifications`
- `POST /api/users/me/notifications/:id/read`
- `POST /api/users/me/notifications/read-all`
- `GET /api/users/me/notifications/unread-count`

Mount in `index.js`.

---

## Task 4: routes/tasks.js — 7 endpoints

**Files:**
- Create: `backend/routes/tasks.js`
- Modify: `backend/index.js`

| Method | Path |
|---|---|
| GET    | `/api/tasks` |
| POST   | `/api/tasks` |
| GET    | `/api/tasks/:id` |
| PUT    | `/api/tasks/:id` |
| POST   | `/api/tasks/:id/status` |
| POST   | `/api/tasks/:id/snooze` |
| DELETE | `/api/tasks/:id` |

Wrap tasksService. On create, fire notif `task_assigned` if owner != creator + Telegram personal if owner has chat_id.

---

## Task 5: mentionParser + internal comments routes

**Files:**
- Create: `backend/services/mentionParser.js`
- Modify: `backend/routes/inbox.js` (add comments endpoints)
- Modify: `backend/routes/users.js` (add `/active` for autocomplete cache)

Functions:
- `mentionParser.extract(body)` → returns array of usernames from `/@(\w+)/g`
- `mentionParser.resolve(client, usernames)` → returns `[{id, username}]` for active staff

New endpoints:
- `GET  /api/inbox/conversations/:id/comments` — list ascending
- `POST /api/inbox/conversations/:id/comments` — body `{body, mentions?}` (defensive resolve server-side)
- `GET  /api/users/active` — list active staff (id, username, full_name) for autocomplete cache

On comment create with mentions: insert `crm_notifications` per mentioned user (skip self) + Telegram personal if has chat_id.

---

## Task 6: bulk action endpoints

**Files:**
- Modify: `backend/routes/inbox.js` (add 3 bulk endpoints)
- Modify: `backend/routes/pipeline.js` (add 1 bulk endpoint)

Endpoints with response shape `{ok, failed, errors}`:
- POST `/api/inbox/bulk-assign` `{conv_ids, staff_id}`
- POST `/api/inbox/bulk-snooze` `{conv_ids, hours}`
- POST `/api/inbox/bulk-close` `{conv_ids}`
- POST `/api/inbox/bulk-tag` `{conv_ids, tag_id, action}` — extend existing if any
- POST `/api/pipeline/bulk-stage` `{conv_ids, stage, lost_reason?, lost_note?}`

Per-row processing inside try/catch, accumulate ok/failed.

---

## Task 7: routes/savedViews.js

**Files:**
- Create: `backend/routes/savedViews.js`
- Modify: `backend/index.js`

| Method | Path |
|---|---|
| GET    | `/api/saved-views?scope=inbox` |
| POST   | `/api/saved-views` |
| PUT    | `/api/saved-views/:id` |
| DELETE | `/api/saved-views/:id` |

is_shared=TRUE only allowed for admin role. PUT/DELETE: owner OR admin (for shared).

---

## Task 8: telegramNotify.sendToStaff helper + telegram-test endpoint

**Files:**
- Modify: `backend/services/telegramNotify.js`
- Modify: `backend/routes/users.js`

Add `sendToStaff(staffId, text, opts)` that looks up `staff_users.telegram_chat_id` and overrides chat_id in send.

Add `POST /api/users/me/telegram-test` — fire greeting to current user's personal chat_id.

Add `PUT /api/users/me/telegram` `{telegram_chat_id}` for self-update.

---

## Task 9: scripts/taskReminder.js

**Files:**
- Create: `backend/scripts/taskReminder.js`

Cron 5-min:
1. SELECT due tasks (status in open|in_progress, reminder_sent_at NULL, due_at ≤ now+1h, due_at ≥ now-24h)
2. For each: notif insert + Telegram personal + UPDATE reminder_sent_at
3. SELECT overdue tasks (due_at < now-24h, status active, overdue_sent_at NULL)
4. For each: notif insert + Telegram + UPDATE overdue_sent_at

---

## Task 10: anomalyDetector + dailyBrief extensions

**Files:**
- Modify: `backend/scripts/anomalyDetector.js`
- Modify: `backend/scripts/dailyBrief.js`

anomaly: add `tasks_overdue_spike` kind — alert if count(overdue >48h) >5
brief: add Tasks block — open/due/overdue counts

---

## Task 11: Cron entry install

**Files:**
- Modify: `/etc/cron.d/crm-pilot` (manual sudo)

Add: `*/5 * * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/taskReminder.js >> /home/krttpt/crm/logs/cron-task-reminder.log 2>&1`

---

## Task 12: Frontend — NotificationsBell component

**Files:**
- Create: `frontend/src/components/NotificationsBell.jsx`
- Modify: `frontend/src/components/Layout.jsx`

Bell icon with unread badge. Polling unread-count every 30s. Click → dropdown with 10 latest, mark on click. "Mark all read" button.

---

## Task 13: Frontend — /tasks page + composer modal

**Files:**
- Create: `frontend/src/pages/tasks.js`
- Create: `frontend/src/components/TaskComposerModal.jsx`
- Create: `frontend/src/components/TaskCard.jsx`
- Modify: `frontend/src/components/Layout.jsx` (add nav item)

Layout: filter top + grouped list (Today/Tomorrow/Later/No date/Overdue/Done last 7d). Inline actions per card.

Composer modal: title, body, owner, conv link search, due datetime, priority.

---

## Task 14: Frontend — InternalCommentsBlock + MentionAutocomplete

**Files:**
- Create: `frontend/src/components/InternalCommentsBlock.jsx`
- Create: `frontend/src/components/MentionAutocomplete.jsx`
- Modify: `frontend/src/components/CustomerPanel.jsx` (mount block)

Comments list chronological + composer with mention autocomplete overlay.

---

## Task 15: Frontend — BulkActionsToolbar extension

**Files:**
- Modify: `frontend/src/pages/inbox/index.js`
- Modify: `frontend/src/pages/pipeline.js` (or PipelineBoard component)

Toolbar appears when ≥1 selected. 6 buttons: Assign / Snooze / Stage / Tag (add+remove) / Close / Clear. Confirmation modal for ≥10 conv.

---

## Task 16: Frontend — SavedViewsDropdown

**Files:**
- Create: `frontend/src/components/SavedViewsDropdown.jsx`
- Modify: `frontend/src/pages/inbox/index.js`
- Modify: `frontend/src/pages/pipeline.js`

Dropdown with own + shared views. Save current → modal. Apply → set URL params.

---

## Task 17: Frontend — /users profile telegram + tasks block in CustomerPanel

**Files:**
- Modify: `frontend/src/pages/users.js` (add my profile section with telegram_chat_id input + Test button)
- Modify: `frontend/src/components/CustomerPanel.jsx` (add Tasks block)

---

## Task 18: Smoke E2E + UAT

Build frontend, restart backend, manual UAT:
1. Create task assigned to other operator → notif + telegram
2. Task due → cron reminder fires
3. @mention 2 users in 1 comment → both notif
4. Bulk close 5 conv → status updated
5. Save view "VIP open" → reload → filter applied
6. Telegram personal test → greeting received

---

## Self-Review

All 15 spec sections covered:
- §3 Data model: Task 1 ✓
- §4 Tasks: Tasks 2, 4, 9, 13, 17 ✓
- §5 Internal comments: Tasks 5, 14 ✓
- §6 Bulk actions: Tasks 6, 15 ✓
- §7 Saved views: Tasks 7, 16 ✓
- §8 Notifications: Tasks 3, 12 ✓
- §9 Telegram personal: Tasks 8, 17 ✓
- §10 API endpoints: Tasks 3, 4, 5, 6, 7, 8 ✓
- §11 Edge cases: covered in service guards
- §12 Testing: Tasks 2, 3 unit; Task 18 smoke
- §13 Telemetri: Task 10 ✓
- §15 Implementation outline: matches task breakdown
