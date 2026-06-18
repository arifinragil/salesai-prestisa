# Supervisor Control Panel — Revamp Design

Date: 2026-06-18
Status: Approved (brainstorm) → ready for writing-plans
Branch: `feat/supervisor-control-revamp`
Supersedes/extends: `2026-06-17-supervisor-control-5group-design.md`, `2026-06-17-native-taxonomy-autolearning-design.md`
Source brief: `img/supervisor_control/# Supervisor Control Panel — Portable Build Brief.docx` + 9 UI screenshots

## 1. Goal

Extend the existing Supervisor Control panel (PR #1) up to the richer "Portable Build Brief"
spec, adapted for Prestisa (toko bunga: papan, bouquet, parsel, cake) and for our actual
data model. This is an **extend**, not a rebuild: keep the lotus-state foundation, diagnosis
(Gemini Flash), taxonomy, and components from PR #1; add the missing pieces.

### Approved decisions (brainstorm)
1. **Extend** the existing implementation (not rebuild).
2. **Diagnosis = Gemini 2.5 Flash** — already in `analystReport.js`; the brief's OpenAI
   gpt-4o-mini requirement is substituted by our existing Gemini Flash + `geminiClient.js`.
   (`GEMINI_API_KEY` set in `/home/krttpt/crm/.env`.)
3. Four must-have deliverables: **Sales Janji Belum Balik**, **FU Hari H 3-cycle**,
   **Action Tracker + Daily Recap**, **Training examples few-shot**.
4. **FU Hari H 3-cycle is derived from messages** — no `crm_followup_outcomes` table.
5. Conversation identity = `lotus_id`; "Buka Conv" → `/lotus-inbox/[lotus_id]`.
6. Screenshot **"Stage" → `lead_status`**, **"Temp" → `lead_temperature`**.
7. All timing uses the **TZ-corrected `received_at`** (fixed 2026-06-18).
8. Migrations are sequential **037–039** (not the brief's 064–067).

## 2. Current state (what we already have — reuse)

Backed by **`crm_lotus_state`** (PK `lotus_id`, Postgres `vonage_reports`) joined with the
**lotus DB** (`contacts`, `messages`; read-only mirror). Two DBs, no cross-JOIN.

- Page: `frontend/src/pages/supervisor-control/index.js` (thin) + components
  `PriorityQueue.jsx`, `GroupSection.jsx`, `LeadCard.jsx`, `DiagnosisPanel.jsx`.
- Routes: `backend/routes/supervisorControl.js` — `GET /api/supervisor-control/panel?scope`,
  `POST /lead/:lotus_id/action` (ack/resolve/revise_ai/...), `GET /lead/:lotus_id/actions`.
- Diagnosis: `backend/services/analystReport.js` — Tier A (JSON, 13 fields) + Tier B
  (markdown), **gemini-2.5-flash**, corrections injection from `crm_lead_supervisor_actions`
  (last 15 `revise_ai`). Taxonomy: `analystTaxonomy.js`, `stuckGroup.js` (root_cause_tag → A/B/C/D).
- Cron: `cron_analyst_tier_a_prewarm.js` (nightly Tier A pre-warm).
- Migrations at **036**. `messages.direction = 'inbound'|'outbound'` (NOT 'in'/'out').
- No `crm_orders`, no `crm_followup_outcomes`, no `pipeline_stage`.

## 3. Data model (new migrations)

### 037 — `crm_ai_training_examples` (brief migration 066)
```sql
CREATE TABLE crm_ai_training_examples (
  id BIGSERIAL PRIMARY KEY,
  case_pattern TEXT NOT NULL,
  category VARCHAR(64) NOT NULL,            -- customer | sales_handling | offer | process
  subtype  VARCHAR(96),
  analysis TEXT NOT NULL,
  suggested_action TEXT,
  suggested_script TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'manual_entry',   -- supervisor_revise | manual_entry
  source_action_id BIGINT,                  -- FK-ish to crm_lead_supervisor_actions.id
  created_by INT REFERENCES staff_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  usage_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  CONSTRAINT chk_training_category CHECK (category IN ('customer','sales_handling','offer','process'))
);
CREATE INDEX idx_training_active_category
  ON crm_ai_training_examples (active, category, last_used_at DESC NULLS LAST);
```
Category maps to our A/B/C/D buckets: customer→A, sales_handling→B, offer→C, process→D.

### 038 — structured supervisor review fields on `crm_lotus_state` (brief 065/067)
```sql
ALTER TABLE crm_lotus_state
  ADD COLUMN supervisor_agree_with_ai BOOLEAN,                    -- TRUE/FALSE/NULL
  ADD COLUMN supervisor_todo          TEXT,                       -- action plan supervisor
  ADD COLUMN supervisor_solved        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN supervisor_outcome       VARCHAR(32);                -- closing|lost|parked|still_fu|unknown
```
Per-lead review state (one current review per lead). Existing `supervisor_ack_at`/`_by` reused.
The append-only audit stays in `crm_lead_supervisor_actions`.

### 039 — perf indexes (optional, if panel > 3s)
Composite/partial indexes on `crm_lotus_state(status, supervisor_solved)` and any hot lotus
`messages` scans introduced by promise/FU/ghost queries. Add only if measured slow.

No orders/followup-outcome tables. "Has closed order" and "FU cycle" are derived from messages.

## 4. Backend

All mounted at `/api/supervisor-control`. Guard: `requireStaff` + admin/supervisor role
(reuse existing admin-guard pattern).

**Human-staff outbound definition (resolves brief's `sender_type` assumption):** in lotus
`messages`, a human-sales message = `direction='outbound' AND cs_id IS NOT NULL`. Outbound
with `cs_id IS NULL` = system / AI / auto-reply (e.g. the "Halo Pak/Ibu" menu). All
"last human reply", "sales promise", and "sales FU" logic uses `cs_id IS NOT NULL`.

### New services
- **`salesPromise.js`** — promise detection. Query lotus `messages`: `direction='outbound'
  AND cs_id IS NOT NULL`, `received_at` in **3h–48h ago**, body `~*` promise regex (Bahasa
  Indonesia, from brief §3.1C). Latest promise per `cust_number` via `DISTINCT ON`. Exclude
  leads where a later human-staff outbound exists after the promise.
- **`followupHariH.js`** — derive 3-cycle FU overdue from messages (no table). For leads with
  `first_inbound_at >= CURRENT_DATE`: count sales FU attempts after customer-ghost vs SLA
  windows. `expected_cycle ∈ {1,2,3}` using time-since-inbound and time-since-last-sales-FU
  (default 2h / 4h / 8h; tunable). Output split `pendingFuByCycle = {1:[],2:[],3:[]}`.
- **`trainingExamples.js`** — CRUD + `getActiveExamples({limit:5})` (DISTINCT ON category,
  max 2/category, order usage_count + recency) + `createFromRevision(action)`. Increments
  `usage_count`/`last_used_at` when injected.

### Extend `analystReport.js`
Inject top-5 training examples block into the Tier A system prompt, alongside the existing
corrections injection. Examples formatted per brief §4.5.

### Extend `supervisorControl.js` — `GET /panel` response
```ts
{
  responseRisk: {
    customerWaiting: [LeadRow],     // last_in > last_out_human, > 10 min, 24h window
    slowFirstResponse: [LeadRow],   // first reply > 1 min OR no_reply_yet (today)
    salesPromiseBroken: [LeadRow],  // from salesPromise.js
  },
  followUp: {
    customerGhost: [LeadRow],       // sales replied last, customer ghost 1h-24h
    bubbleChat: [LeadRow],          // 1 inbound, body < 50 char, > 1h, 48h window
    pendingFuByCycle: { 1:[], 2:[], 3:[] },  // from followupHariH.js
  },
  leadStuckByCategory: { A:[], B:[], C:[], D:[], uncategorized:[] },
  priority: {
    p1, p1Items: { customerWaitingCritical, leadNoReply, salesPromiseBroken },
    p2, p2Items: { customerGhost, fuCycleIncomplete, leadStuck },
    p3, p3Items: { bubbleChat, slowFirstResponseMild },
    total,
  },
  counts, generatedAt,
}
```
Keep `scope=mine|team`. Lead-stuck exclusion: hide leads the supervisor already
`ack/resolved` UNLESS the customer replied again after the action (needs re-review).

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/diagnosis/:lotus_id/review` | 5-step structured review (agree/solved/todo/outcome/revise) |
| POST | `/:lotus_id/review-no-diagnose` | Manual review without AI dx (inserts `ai_model='manual'`) |
| POST | `/bulk-diagnose` | `{ lotus_ids:[...] }` max 100, sequential, 200ms delay |
| GET | `/actions?range=30 \| date_from&date_to` | Action Tracker (compliance backlog) |
| GET | `/daily-recap?date=YYYY-MM-DD` | Daily Recap |
| GET | `/training-examples?active=` | List |
| POST | `/training-examples` | Create manual |
| PUT | `/training-examples/:id` | Update / re-activate |
| DELETE | `/training-examples/:id` | Soft delete (active=false) |

Review derivation: `solved → supervisor_solved=true` (else ack); if `agree_with_ai=false`
+ revise_category + revise_note → `trainingExamples.createFromRevision()`. Match-rate for
Daily Recap = `agreed / (agreed + revised)`.

### Action Tracker / Daily Recap shapes
Per brief §5.2 / §5.3, computed over `crm_lotus_state` + `crm_lead_supervisor_actions`:
backlog = leads not yet reviewed (`not_reviewed`), `reviewed_open`, `done` (`supervisor_solved`);
per-supervisor compliance; Daily Recap match-rate (4xl), issue breakdown by A/B/C/D + subtype,
bubble-chat progress (closed/fu_done/sales_replied/lost/no_action).

## 5. Frontend — `/supervisor-control`

Next.js Pages Router (matches brief). Layout per screenshots:
```
<Layout>
  <PrioritySummary />            // sticky dark bar: P1/P2/P3 + total + sub-counts, click→jump
  <GroupCard "1. Sales Response Risk" P1>
    <SubSection ⏰ "Customer Menunggu Balas"  situation + actionHint + LeadRows>
    <SubSection 🚨 "Slow First Response">
    <SubSection 🤝 "Sales Janji Belum Balik"   // promise highlight + hours badge + Salin remind>
  <GroupCard "2. Follow Up Customer" P2>
    <SubSection 👻 "Customer Belum Balas Sales">
    <SubSection 💬 "Bubble Chat 1×">
    <SubSection 🔁 "Follow Up Hari H">  <CycleSplit 1/2/3 />
  <GroupCard "3. Lead Stuck Belum Closing" P2>
    A / B / C / D / Belum Di-Diagnose (+ BulkDiagnose button)
  <AITrainingCard />            // few-shot CRUD
  <ActionTrackerCard />         // compliance backlog, date filter
  <DailyRecapCard />            // match-rate 4xl + issue breakdown + bubble progress (bottom)
</Layout>
```

### Components
- Reuse: `PriorityQueue` → becomes `PrioritySummary` (sticky), `GroupSection`/`LeadCard`
  (extend to `SubSection`/`LeadRow` polish), `DiagnosisPanel`.
- New: `SubSection` (icon-bulat brand + situation band gray-50 + action-hint band brand-50),
  `ReviewForm` (5-step: agree radio → revise category/subtype/note → solved radio → todo
  textarea → outcome radio), `CycleSplit`, `AITrainingCard`, `ActionTrackerCard`,
  `DailyRecapCard`.
- LeadRow actions: **Chat** → open `/lotus-inbox/[lotus_id]` (new tab), **Salin remind**
  (copy template), **Review Dx** (expand DiagnosisPanel), **Review** (open ReviewForm).
- SWR `GET /panel` `refreshInterval: 60_000`; `mutate()` after every supervisor action.
- Tailwind: add `xs: '420px'` breakpoint; mobile stacking per brief §6.3.

### Field mapping (our model → screenshot labels)
- "Stage tertarik" → `crm_lotus_state.lead_status`.
- "Temp warm/cold/hot" → `lead_temperature`.
- "Wawa / Ragil" (sales) → `staff_users.full_name` via `assigned_staff_id`.
- "Tunggu 22j 12m" / "Ghost 23.8j" → computed from corrected `received_at`.
- Ghost/test-user filter → adapt brief regex to our naming conventions.

## 6. Phasing (implementation order)

1. Migrations 037 + 038.
2. `salesPromise.js` + `followupHariH.js` (pure-ish, testable) + wire into `/panel`.
3. `trainingExamples.js` + inject into `analystReport.js` + training endpoints.
4. Review endpoints (`/review`, `/review-no-diagnose`, `/bulk-diagnose`).
5. Action Tracker + Daily Recap endpoints.
6. Frontend: PrioritySummary + GroupCards + SubSection + LeadRow + ReviewForm.
7. AITrainingCard + ActionTrackerCard + DailyRecapCard.
8. Mobile polish; smoke test (live conv → click all → revise → training example created).

## 7. Acceptance criteria

### Backend
- [ ] Migrations 037/038 applied.
- [ ] `GET /panel` returns all sub-sections + priority in < 3s.
- [ ] Ghost/test-user regex excludes test/demo accounts.
- [ ] `salesPromiseBroken` matches: "Baik ini sedang kami ajukan dlu ya ka, nanti klo sudah
      keluar harga nya kami infokan kembali".
- [ ] FU Hari H 3-cycle: overdue leads land in the correct `expected_cycle`.
- [ ] Diagnose returns in reasonable Gemini-Flash latency; training examples injected (verify
      in stored `ai_raw`).
- [ ] `agree_with_ai=false` + note + category → training example auto-created.
- [ ] Bulk diagnose 30+ leads without Gemini rate-limit errors.

### Frontend
- [ ] PrioritySummary sticky; P1/P2/P3 click → scroll + force-open group.
- [ ] SubSection shows icon + situation + action hint (not flat).
- [ ] LeadRow "Chat" opens `/lotus-inbox/[lotus_id]` in new tab.
- [ ] ReviewForm 5-step submit → row leaves list when solved=true.
- [ ] Daily Recap match-rate prominent (4xl); bubble progress present.
- [ ] Mobile: closing button on chat not blocked by any banner.

### Operational
- [ ] Gemini Flash cost monitored; bulk diagnose bounded.
- [ ] Match-rate displayed prominent (target ↑ via training examples).
