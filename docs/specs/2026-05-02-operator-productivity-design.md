# Operator Productivity Suite — Design Spec

**Sub-project 2 dari 3** dalam roadmap "Conversion + Retention + Operasional" Tiara CRM.
Sub-project lain: ✅ #1 Sales Pipeline (selesai), ⏳ #3 Retention/Lifecycle Automation.

**Date:** 2026-05-02
**Status:** Draft — pending implementation
**Owner:** finance.parselia@gmail.com
**MVP Scope:** 4 high-impact features. Defer ke v2: calendar, leaderboard, internal threads (separate from comments), bulk tag merge.

---

## 1. Tujuan & Outcome

Operator handle banyak conversation paralel + perlu kolaborasi tim. Saat ini:
- Tidak ada **task tracking** — operator pakai sticky note / WhatsApp pribadi untuk reminder follow-up.
- Tidak ada **internal collaboration** per conv — kalau mau minta tolong rekan, harus pindah ke WhatsApp / Telegram terpisah, kehilangan context.
- **Bulk action** terbatas (cuma add tag), operator klik manual untuk action repetitif.
- Tidak ada **saved view** — operator setup filter kombinasi yang sama setiap hari.

Sub-project ini membangun toolkit produktivitas operator: tasks (per-conv atau standalone) dengan reminder, internal comment thread dengan @mention live autocomplete + notif, bulk actions diperkaya (assign/snooze/stage/tag/close), saved view per-user dan shared.

**Success criteria:**
- Operator tidak perlu sticky note / channel external untuk track follow-up commitment.
- @mention sampai ke target operator dalam <2 menit (in-app + opt-in Telegram personal).
- Bulk action handle 50 conv dalam <5 detik.
- Saved view di-load <2 detik dengan filter signature lengkap.

---

## 2. Scope

**In scope (v1):**
- **Tasks & reminders** — hybrid (conv-scoped atau standalone), assign self atau 1 operator lain, 4-state workflow (open|in_progress|done|cancelled), due datetime + reminder 1 jam sebelum, notifikasi in-app + opt-in Telegram personal.
- **Internal comments + @mention** — comment thread per conv (separate dari Notes static), live autocomplete dropdown, mention via parser, notifikasi in-app + Telegram personal.
- **Bulk actions** — extend existing bulk: 6 actions (assign operator, snooze 1h/4h/24h/3d, set pipeline stage, add/remove tag, close/reopen, clear selection). Confirmation modal untuk ≥10 conv.
- **Saved views** — per-user atau shared (admin-only kalau shared), scope `inbox` atau `pipeline`, simpan kombinasi filter aktif.
- **Notifications panel** — bell icon top bar dengan count unread + dropdown 10 latest.
- **Telegram personal binding** — opt-in field di user profile edit, test endpoint.

**Out of scope (defer ke v2):**
- Calendar view (day/week/month aggregating tasks + delivery + handover).
- Leaderboard (top closer/CSAT/response time gamification).
- Internal threads terpisah per topic dalam 1 conv (saat ini single thread per conv via `crm_internal_comments`).
- Bulk tag merge (gabung 2 tag duplikat).
- Recurring tasks (daily/weekly/monthly templates).
- Subtasks / checklist dalam 1 task.
- Bulk send template/snippet (anti-blast risk).
- Multi-assignee task (saat ini single owner).

**Eksplisit tidak dibangun:** task comments dalam task itu sendiri (gunakan internal comments di conv terkait). Inline editing task title (cukup edit modal).

---

## 3. Data Model

### 3.1 Tabel baru `crm_tasks`

```sql
CREATE TABLE crm_tasks (
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

CREATE INDEX crm_tasks_owner_status_idx ON crm_tasks (owner_id, status, due_at);
CREATE INDEX crm_tasks_conv_idx ON crm_tasks (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX crm_tasks_due_pending_idx ON crm_tasks (due_at)
  WHERE status IN ('open','in_progress') AND reminder_sent_at IS NULL;
```

**Allowed values:**

| Field | Values |
|---|---|
| `status` | `open` \| `in_progress` \| `done` \| `cancelled` |
| `priority` | `low` \| `normal` \| `high` |

### 3.2 Tabel baru `crm_internal_comments`

```sql
CREATE TABLE crm_internal_comments (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  staff_id        integer NOT NULL REFERENCES staff_users(id),
  body            text NOT NULL,
  mentions        integer[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_internal_comments_conv_idx ON crm_internal_comments (conversation_id, id DESC);
CREATE INDEX crm_internal_comments_mention_idx ON crm_internal_comments USING GIN (mentions);
```

`mentions` array of `staff_users.id` yang ter-resolve dari `@username` parsing saat submit.

### 3.3 Tabel baru `crm_notifications`

```sql
CREATE TABLE crm_notifications (
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

CREATE INDEX crm_notifications_staff_unread_idx
  ON crm_notifications (staff_id, created_at DESC) WHERE read_at IS NULL;
```

**Kinds:** `task_assigned`, `task_due`, `task_overdue`, `mention`, `task_cancelled`, `bulk_action_failed` (defensive).

### 3.4 Tabel baru `crm_saved_views`

```sql
CREATE TABLE crm_saved_views (
  id          serial PRIMARY KEY,
  staff_id    integer REFERENCES staff_users(id) ON DELETE CASCADE,
  scope       varchar(16) NOT NULL,
  name        varchar(80) NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_shared   boolean NOT NULL DEFAULT FALSE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (scope IN ('inbox', 'pipeline'))
);

CREATE INDEX crm_saved_views_staff_scope_idx ON crm_saved_views (staff_id, scope) WHERE staff_id IS NOT NULL;
CREATE INDEX crm_saved_views_shared_scope_idx ON crm_saved_views (scope) WHERE is_shared = TRUE;
```

`is_shared = TRUE` AND `staff_id` boleh tetap ada (creator tracked) atau NULL (system seed). Visible ke semua user kalau is_shared.

### 3.5 Extend `staff_users`

```sql
ALTER TABLE staff_users
  ADD COLUMN telegram_chat_id varchar(40),
  ADD COLUMN telegram_token   varchar(64);
```

`telegram_chat_id` = chat ID personal user. `telegram_token` = secret untuk verify bot binding (opsional, fase v2).

### 3.6 Seed default saved views

Migration insert default views (`staff_id = NULL` + `is_shared = TRUE`):

- inbox: "Belum diambil hari ini" → `{queue: 'unassigned', date_from: 'today'}`
- inbox: "Open handover" → `{has_open_handover: true}`
- inbox: "VIP" → `{tag_name: 'VIP'}` (resolve tag_id at query time)
- pipeline: "Form sent stale >24h" → `{stage: 'form_dikirim', stage_age_hours: 24}`
- pipeline: "High-value" → `{type: 'wedding|b2b'}`
- pipeline: "Lost no_reply 7d" → `{stage: 'lost', lost_reason: 'no_reply', date_from: 'last_7d'}`

---

## 4. Tasks UX & Behavior

### 4.1 Page baru `/tasks`

Layout:
- Top bar: `[+ New task]` button, filter dropdown `Owner: Me | All`, `Status: Active (open+in_progress) | All | Done | Cancelled`
- Body: grouped list by due:
  - **Today** (due ≤ end-of-today)
  - **Tomorrow**
  - **Later this week**
  - **No due date**
  - **Overdue ⚠** (due < now AND status != done|cancelled)
  - **Done last 7d** (collapsed)
- Tiap task card:
  - Icon priority (🔴 high / blank normal / ⚪ low)
  - Title bold + body preview 1 line
  - Due time relative
  - Conv link badge (jika linked) — clickable ke `/inbox/{id}`
  - Created by (jika != owner)
  - Inline actions: `▶ Start` (open→in_progress), `✓ Done`, `Snooze 1h ▾` (1h/4h/1d/3d), `Edit`, `✗ Cancel`

### 4.2 Composer modal

Triggered:
- `[+ New task]` di /tasks
- `[+ Task]` di CustomerPanel chat detail (auto-link `conversation_id`)

Fields:
- **Title** (required, max 200 char)
- **Body** (optional, plain text + line breaks)
- **Owner** dropdown — list `staff_users WHERE active=TRUE AND disabled_at IS NULL`. Default: self.
- **Conv link** — auto-set kalau dari chat detail; manual select via search dropdown otherwise (search by phone/push_name)
- **Due datetime** — date + time picker. Default: tomorrow 17:00 WIB.
- **Priority** — low / normal / high. Default: normal.

Submit → POST `/api/tasks` → notif `task_assigned` ke owner kalau owner != creator.

### 4.3 Status transitions

| From | To | Allowed by | Side effect |
|---|---|---|---|
| open | in_progress | owner | none |
| open | done | owner OR creator | set `completed_at` |
| open | cancelled | owner OR creator | set `cancelled_at`, `cancel_reason` (optional input) |
| in_progress | done | owner | set `completed_at` |
| in_progress | open | owner | clear `completed_at` (rare) |
| done | open | owner OR creator | re-open (clear `completed_at`) |

### 4.4 Reminder + overdue

Cron `scripts/taskReminder.js` setiap 5 menit:

```sql
-- Due reminder
SELECT id, owner_id, title, due_at, conversation_id
FROM crm_tasks
WHERE status IN ('open','in_progress')
  AND reminder_sent_at IS NULL
  AND due_at <= now() + interval '1 hour'
  AND due_at >= now() - interval '24 hours';
```

For each:
1. Insert `crm_notifications` row (kind=`task_due`, link=`/tasks?focus={id}`).
2. If owner has `telegram_chat_id` non-null → fire personal Telegram DM.
3. UPDATE `crm_tasks SET reminder_sent_at = now()`.

Overdue (separate query in same cron):

```sql
SELECT id, owner_id, title FROM crm_tasks
WHERE status IN ('open','in_progress')
  AND due_at < now() - interval '24 hours'
  AND overdue_sent_at IS NULL;
```

Same flow with kind=`task_overdue`, set `overdue_sent_at`.

### 4.5 Chat detail integration (CustomerPanel)

Section baru "Tasks (N)":
- List compact (title + due + status icon).
- `+ Tambah task` button → composer modal pre-filled `conversation_id`.
- Klik task → `/tasks?focus={id}` (open task highlighted).

### 4.6 Top bar global

Badge `Tasks (X)` di nav: count `WHERE owner_id = me AND status IN ('open','in_progress') AND (due_at IS NULL OR due_at <= end_of_today)`. Klik → `/tasks`.

---

## 5. Internal Comments + @mention

### 5.1 UI per chat detail

Section baru di CustomerPanel (atau permanent block di chat detail bottom sidebar):

```
💬 Internal Comments (3)
─────────────────────────
Sari · 2j lalu
  @andi tolong cek invoice ini, customer minta PO.
Andi · 1j lalu
  Sip, aku follow up.
─────────────────────────
[Tulis komentar internal… (@nama untuk tag)]
[📨 Kirim]
```

Render chronological ascending. Auto-scroll bottom on new comment.

### 5.2 Mention autocomplete

Implementation client-side:
- Detect `@` token at cursor saat user mengetik.
- Fetch `GET /api/users/active` sekali at chat-detail load (cache di-memory).
- Filter `username STARTS WITH (token after @)` live.
- Render overlay dropdown above textarea — keyboard nav (Up/Down pilih, Enter/Tab insert, Esc tutup).
- Insert: replace `@<partial>` → `@<full_username>` + simpan `staff_id` di `mentions[]` state.
- Multiple mentions per komentar OK.

Server-side parser (defensive, untuk fallback kalau frontend skip):
- Regex `/@([a-zA-Z0-9_-]+)/g` extract username candidates.
- Resolve via `SELECT id, username FROM staff_users WHERE username = ANY($1) AND active = TRUE`.
- Insert ke `crm_internal_comments.mentions` array.

### 5.3 Submit flow

POST `/api/inbox/conversations/:id/comments` body `{body, mentions: [staff_id, ...]}`:
1. Server re-validate `mentions` (filter ke staff_users yang valid).
2. INSERT `crm_internal_comments`.
3. For each mentioned user (selain creator): INSERT `crm_notifications` (kind=`mention`, link=`/inbox/{conv_id}`, body=comment text snippet first 200 char).
4. For each mentioned user dengan `telegram_chat_id` non-null: fire personal Telegram DM.

### 5.4 Visibility & isolation

- Internal comments TIDAK pernah masuk ke WhatsApp. Tidak hit `waClient.sendText`.
- Tidak muncul di `/api/inbox/conversations/:id/messages` endpoint.
- Hanya visible di CRM frontend untuk staff user.

---

## 6. Bulk Actions

Existing inbox sudah ada `bulk select` checkbox + `bulk add tag`. Tambah toolbar yang muncul saat ≥1 row terpilih:

```
┌──────────────────────────────────────────────────────────────────┐
│ ✓ 12 dipilih   [Assign▾] [Snooze▾] [Stage▾] [Tag▾] [Close] [✗] │
└──────────────────────────────────────────────────────────────────┘
```

### 6.1 Six actions

| Action | Endpoint | Body |
|---|---|---|
| Assign | POST `/api/inbox/bulk-assign` | `{conv_ids, staff_id}` (staff_id = NULL untuk un-assign) |
| Snooze | POST `/api/inbox/bulk-snooze` | `{conv_ids, hours}` |
| Stage (pipeline) | POST `/api/pipeline/bulk-stage` | `{conv_ids, stage, lost_reason?, lost_note?}` |
| Tag add | POST `/api/inbox/bulk-tag` | `{conv_ids, tag_id, action: 'add'}` |
| Tag remove | POST `/api/inbox/bulk-tag` | `{conv_ids, tag_id, action: 'remove'}` |
| Close | POST `/api/inbox/bulk-close` | `{conv_ids}` |
| Clear selection | client-side only | — |

### 6.2 Confirmation & error handling

- Action ≥10 conv → confirmation modal dengan summary "Apply 'Snooze 4h' to 12 conv?"
- Backend response shape: `{ok: 10, failed: 2, errors: [{conv_id, message}, ...]}`
- Frontend toast: "10 ✓ · 2 gagal" + collapse expandable list of failed conv_ids dengan reason.
- Optimistic UI: row state updated immediately; revert + refetch saat partial failure.

### 6.3 Atomic vs per-row

Per-row processing (loop `conv_ids`, catch error per iteration). Tidak transaction-wrap supaya partial success masih commit. Setiap action call existing engine/services yang sudah ada (mis. bulk-stage call `pipelineEngine.apply` per conv).

---

## 7. Saved Views

### 7.1 UI

Toolbar `/inbox` dan `/pipeline`:
- Dropdown `📌 Views ▾` di kiri filter — list user's own views + shared views.
- Selected view name shown sebagai chip aktif.
- `+ Save current view as…` di bottom dropdown → modal.

Modal:
- **Name** (required, max 80 char)
- **Share with team** checkbox (admin only — disabled untuk operator/viewer)
- Submit → POST `/api/saved-views` `{scope, name, filters: {<current URL params>}, is_shared}`

Per-view kebab `⋯`:
- Rename (own views OR admin for shared)
- Delete (own views OR admin for shared)

### 7.2 Apply view

Klik view → set URL params dari `filters` JSON → SWR re-fetch list dengan filter baru.

URL signature scope:
- `inbox`: `queue, status, tag_id, pipeline_stage, wa_session, search`
- `pipeline`: `type, claimed_by, tag_id, date_from`

Filter keys yang tidak ada di scope signature ignored saat apply.

### 7.3 API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/saved-views?scope=inbox` | staff | List views user + shared, filter by scope |
| POST | `/api/saved-views` | staff | Create. is_shared TRUE only allowed if role=admin |
| PUT | `/api/saved-views/:id` | staff (own) atau admin (shared) | Rename or update filters |
| DELETE | `/api/saved-views/:id` | staff (own) atau admin (shared) | Delete |

---

## 8. Notifications Panel

### 8.1 UI

Bell icon di top bar (Layout):
- Badge count: `crm_notifications WHERE staff_id = me AND read_at IS NULL`
- Klik → dropdown panel:
  - Header: "Notifikasi" + tombol "Mark all read"
  - List 10 latest (unread bold + bg-amber-50)
  - Setiap row: icon kind (📋 task / 💬 mention / ⚠ overdue), title, time relative
  - Klik row → mark read + navigate ke `link`
  - Footer: "Lihat semua" → /notifications page (full list, paginated)

### 8.2 API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/users/me/notifications?limit=10&unread_only=false` | List |
| POST | `/api/users/me/notifications/:id/read` | Mark single read |
| POST | `/api/users/me/notifications/read-all` | Mark all unread read |
| GET | `/api/users/me/notifications/unread-count` | Just count (for badge polling) |

### 8.3 Polling vs realtime

Bell badge polling via SWR every 30s. Cheap query (`COUNT(*) WHERE staff_id=me AND read_at IS NULL`).

Future v2: socket.io push baru notif → instant badge update tanpa polling.

---

## 9. Telegram Personal Binding

### 9.1 Setup flow (manual)

Operator dapat chat ID via:
- Chat `@userinfobot` di Telegram → bot reply dengan `Id: 12345678`.
- Atau klik link bot Tiara → `/start` → bot reply dengan chat ID + token.

Operator buka `/users` profile edit modal → field "Telegram chat ID" (paste angka).

### 9.2 Test endpoint

POST `/api/users/me/telegram-test`:
1. Read `staff_users.telegram_chat_id` dari current user.
2. Fire greeting via `telegramNotify.send` dengan override chat_id (bukan setting global).
3. Return `{ok: true, message_id}` jika sukses.
4. UI button "Test" di profil → klik → toast "✅ Cek Telegram, harusnya nyampe".

### 9.3 sendToStaff helper

Extend `services/telegramNotify.js`:

```js
async function sendToStaff(staffId, text, opts = {}) {
  const r = await pg.query(`SELECT telegram_chat_id FROM staff_users WHERE id = $1`, [staffId]);
  const chatId = r.rows[0]?.telegram_chat_id;
  if (!chatId) return { ok: false, skipped: 'no_personal_chat_id' };
  return send(text, { ...opts, _overrideChatId: chatId });
}
```

`send()` accepts `_overrideChatId` to bypass kind→chatId resolution.

---

## 10. API Endpoints Summary (baru)

| Method | Path | Auth | Notes |
|---|---|---|---|
| **Tasks** | | | |
| GET | `/api/tasks` | staff | Query: `owner_id`, `status`, `conversation_id`, `due_before`, `due_after`, `limit` |
| POST | `/api/tasks` | staff | Create. Body fields per §4.2 |
| GET | `/api/tasks/:id` | staff | Detail |
| PUT | `/api/tasks/:id` | staff (owner or creator) | Edit fields |
| POST | `/api/tasks/:id/status` | staff (owner or creator) | Body `{status, cancel_reason?}` |
| POST | `/api/tasks/:id/snooze` | staff (owner) | Body `{hours}` — push due_at + clear reminder_sent_at |
| DELETE | `/api/tasks/:id` | staff (creator) atau admin | Hard delete (rare) |
| **Internal comments** | | | |
| GET | `/api/inbox/conversations/:id/comments` | staff | List ascending |
| POST | `/api/inbox/conversations/:id/comments` | staff | Create. Body `{body, mentions?}` |
| **Notifications** | | | |
| GET | `/api/users/me/notifications` | staff | Query: `limit`, `unread_only` |
| POST | `/api/users/me/notifications/:id/read` | staff (own) | |
| POST | `/api/users/me/notifications/read-all` | staff | |
| GET | `/api/users/me/notifications/unread-count` | staff | Cheap badge query |
| **Bulk actions** | | | |
| POST | `/api/inbox/bulk-assign` | staff | `{conv_ids, staff_id}` |
| POST | `/api/inbox/bulk-snooze` | staff | `{conv_ids, hours}` |
| POST | `/api/inbox/bulk-tag` | staff | `{conv_ids, tag_id, action: 'add'\|'remove'}` |
| POST | `/api/inbox/bulk-close` | staff | `{conv_ids}` |
| POST | `/api/pipeline/bulk-stage` | staff | `{conv_ids, stage, lost_reason?, lost_note?}` |
| **Saved views** | | | |
| GET | `/api/saved-views?scope=inbox` | staff | |
| POST | `/api/saved-views` | staff | is_shared admin-only |
| PUT | `/api/saved-views/:id` | staff (own) atau admin | |
| DELETE | `/api/saved-views/:id` | staff (own) atau admin | |
| **Telegram personal** | | | |
| POST | `/api/users/me/telegram-test` | staff | Verify binding |
| **User helpers** | | | |
| GET | `/api/users/active` | staff | Used by mention autocomplete; cached client-side |

---

## 11. Edge Cases

1. **Task owner di-disable** — hide task dari "owner=me" filter, tetap visible di "owner=all". Reminder cron skip (left join staff_users dan WHERE active=TRUE).
2. **Conv linked di-delete** — `ON DELETE SET NULL`, task tetap exist sebagai standalone.
3. **Mention ke user yang nonexistent** — autocomplete sudah filter ke valid user; defensive parser server-side drop yang tidak match.
4. **Bulk action partial failure** — return shape `{ok, failed, errors}`, frontend toast dengan list failed.
5. **Saved view dengan tag yang dihapus** — load tetap jalan, filter invalid silently skipped + log warning.
6. **Concurrent task assign** (race) — last-write-wins, no conflict tracking di v1.
7. **Reminder duplicate** — cron query gate by `reminder_sent_at IS NULL` + UPDATE atomic; idempotent meski cron overlap.
8. **Telegram chat_id invalid** (operator typo) — `sendToStaff` log warning + insert in-app notif tetap berhasil. Tidak ada bot block, hanya `chat not found` 400 dari Telegram API.
9. **Task snooze melewati overdue threshold** — `reminder_sent_at = NULL` post snooze; `overdue_sent_at` reset ke NULL juga (snooze re-arms reminder).
10. **Comment dengan mention diri sendiri** — skip notif untuk creator (no self-notif).
11. **Saved view name duplicate per user** — allowed (operator boleh punya 2 view "Today" dengan filter beda); cuma `id` unique.
12. **Bulk close conv yang sudah closed** — no-op per row, count di `ok`.

---

## 12. Testing

### 12.1 Unit tests

**`backend/__tests__/tasks.test.js`:**
- CRUD happy path
- Status transition matrix (allowed vs forbidden)
- Snooze re-arms reminder
- Owner disable hide from query

**`backend/__tests__/internalComments.test.js`:**
- Mention parser regex extract
- Resolve to staff_id (active only)
- Multiple mentions in 1 comment
- Self-mention skipped from notif

**`backend/__tests__/savedViews.test.js`:**
- Scope check (inbox vs pipeline)
- Shared view creation requires admin
- Shared view edit/delete permission

**`backend/__tests__/bulkActions.test.js`:**
- Partial failure response shape
- Per-row error message capture

### 12.2 Integration smoke (manual)

End-to-end UAT:
1. Create task assigned to other operator → verify in-app notif appears + Telegram DM (if opted in)
2. Reach due time → cron picks → notif + Telegram once (re-run cron = idempotent)
3. @mention 2 users in 1 comment → both get notifs
4. Bulk close 5 conv → status updated atomically
5. Save view "VIP open" in inbox → reload → filter applied from URL
6. Telegram personal test endpoint → message arrives

### 12.3 Pre-deploy

- Apply migration di staging
- Insert sample seed (5 tasks, 3 comments) untuk verifikasi UI render
- Manual: bulk action 20 conv → check no timeout
- Manual: cron taskReminder dry-run (tidak fire telegram, just log)

---

## 13. Telemetri & Monitoring

- **Daily brief** tambah baris: "📋 Tasks today: X open · Y due · Z overdue"
- **Anomaly detector** tambah kind `tasks_overdue_spike` — alert kalau >5 tasks overdue >48h (sinyal tim overload)
- **Cron `taskReminder`** log: count notif fired, telegram sent, errors

---

## 14. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Reminder spam (operator over-creates tasks) | Notif fatigue, ignore alert serius | Per-user rate limit: max 20 notifs/hour. Beyond → batch into single digest. v2. |
| Telegram bot blocked oleh operator | Reminder via Telegram silently fail | Fallback ke in-app tetap jalan. Bot block detection: 403 response → reset `telegram_chat_id` to NULL + insert notif "Telegram disconnected, re-bind via profil". |
| Mention autocomplete jadi slow di tim besar | Lag UX | List `staff_users` di-cache client-side (refresh 60s); cap 100 results. |
| Bulk action mass-affect prod conv | Sulit di-undo | Konfirmasi modal ≥10 conv. Audit log per bulk action di `crm_pipeline_events` (untuk stage change) atau new `crm_bulk_action_log` table (out-of-scope v1, log via logger). |
| Saved view dengan filter complex perlahan | Slow load | Indexes existing sudah cover scope filter. Saved view tidak introduce SQL baru, cuma URL params. |
| Notification table grows unbounded | DB bloat | Cron weekly cleanup: DELETE notif read_at < now() - 30d. Defer ke deployment scripts. |
| Comment dengan body besar (paste log) | UI slow | Validate body max 4000 char. Reject submit. |
| Task assigned ke disabled user | Task orphan | Validate owner active saat create. Saat disable user, surface warning di /users page "X tasks owned by this user". |

---

## 15. Implementation Outline

(Detail dijabarkan di plan terpisah lewat skill `writing-plans`)

1. **Migration `014_operator_productivity.sql`** — 4 tabel baru + extend staff_users + seed default views
2. **`services/tasksService.js`** — pure CRUD + status logic
3. **`services/notificationsService.js`** — insert helper + read mark
4. **`services/mentionParser.js`** — regex extract + resolve helper
5. **`routes/tasks.js`** — 7 endpoints
6. **`routes/notifications.js`** atau extend `users.js` — 4 endpoints
7. **`routes/savedViews.js`** — 4 endpoints
8. **`routes/inbox.js` extension** — comments endpoints (2) + bulk endpoints (4)
9. **`routes/pipeline.js` extension** — bulk-stage endpoint
10. **`routes/users.js` extension** — telegram-test + active list endpoints
11. **`services/telegramNotify.js` extension** — sendToStaff helper
12. **`scripts/taskReminder.js`** — cron 5-min
13. **Cron entry** add to `/etc/cron.d/crm-pilot`
14. **Frontend `/tasks` page** — list + composer modal
15. **Frontend `NotificationsBell` component** — top bar + dropdown
16. **Frontend `InternalCommentsBlock`** — chat detail integration
17. **Frontend `MentionAutocomplete`** — overlay component
18. **Frontend `BulkActionsToolbar`** — extend existing inbox + pipeline
19. **Frontend `SavedViewsDropdown`** — toolbar component for inbox + pipeline
20. **Frontend `/users` profile edit** — telegram chat_id field + test button
21. **Frontend `CustomerPanel` extension** — tasks block + comments block
22. **`anomalyDetector.js` extension** — tasks_overdue_spike kind
23. **`dailyBrief.js` extension** — tasks line
24. **Test suite** — 4 unit test files
25. **Smoke E2E + UAT** 1-2 hari sebelum mark complete
