# Supervisor Control Panel (MVP) — Design Spec

**Date:** 2026-06-17
**Project:** crm (salesai.prestisa.net)
**Status:** Approved design — ready for writing-plans

## Goal

A **lead-centric** supervisor dashboard that surfaces leads that are "macet" (stuck),
explains why (AI diagnosis), and lets the supervisor act/acknowledge directly. It is a
**control panel, not a report**: the supervisor sees which leads to rescue first, not raw
data.

This is distinct from and complementary to the existing **agent-centric** `/supervisor`
page (per-salesperson performance scores, red flags, coaching). That page stays as-is.

## Scope decision

MVP-first. This spec covers the high-value core loop:

> scan active leads → compute time-signals → rank by priority → show AI diagnosis →
> supervisor acts (Chat / Assign / Ack / Resolve / Revisi).

This delivers the user's Group 1 (Sales Response Risk), Group 2 (Follow Up Customer),
Group 5 (Priority Lead Queue), and the action half of Group 4 (AI Diagnosis & Supervisor
Review). Group 3's full issue-bucket taxonomy and the AI-learning loop are Phase 2 (see
"Deferred").

## Architecture

- **Nav menu:** `/supervisor-control`, label **"Supervisor Control"**, admin-only entry
  added to `frontend/src/components/Layout.jsx`.
- **Frontend page:** `frontend/src/pages/supervisor-control/index.js`.
- **Backend route:** new `backend/routes/supervisorControl.js`, mounted at
  `/api/supervisor-control`, admin-guarded (mirror the role check in
  `backend/routes/supervisor.js`). Registered in `backend/index.js`.
- **Migration:** one new SQL file under `backend/migrations/` — table
  `crm_lead_supervisor_actions` + an ack/resolve flag on `crm_lotus_state`.

### Reused existing infrastructure (do NOT rebuild)

| Need | Reuse |
|---|---|
| AI Diagnosis | `POST /api/lotus-inbox/contacts/:lotus_id/analyst-report` (Tier A, Gemini 2.5 Flash, cached) |
| Issue taxonomy | `backend/services/rootCauseTaxonomy.js` (13 categories) |
| Time-signal source | `lotus_conversations.messages` (`received_at`, `direction`) |
| Lead state | `crm_lotus_state` (`first_inbound_at`, `first_response_at`, `lead_temperature`, `lead_score`, `status`, `root_cause_tag`, `funnel_stage_lost`) |
| Assign / close / snooze | existing `POST /api/lotus-inbox/contacts/:lotus_id/{assign,close,snooze}` |
| Follow-ups | `crm_followups` (`conversation_id`, `created_at`, `sent_at`, `status`) |

## Signal engine (the heart)

The scanner runs **one SQL pass** per fetch over the queue population, then derives signals
in code.

### Queue population

Active leads that are **not** closed/spam/closing **and** have chat activity within the
**last 7 days**. (Joined `messages` + `crm_lotus_state`; excludes leads ack'd/resolved and
not since re-opened — see Actions.)

### Per-lead computed signals (on-the-fly at each fetch)

- `last_inbound_at` = MAX(received_at) WHERE direction='inbound'
- `last_outbound_at` = MAX(received_at) WHERE direction='outbound'
- `last_is_inbound` = last_inbound_at > last_outbound_at (customer is waiting)
- `awaiting_sales_reply_min` = if `last_is_inbound`: now − last_inbound_at, else null
- `awaiting_customer_reply_min` = if not `last_is_inbound`: now − last_outbound_at, else null
- `never_responded` = `first_response_at` IS NULL (lead never got a first reply)
- `first_response_lag_min` = (first_response_at − first_inbound_at) — "sales lama balas"
- `fu_today` = count of `crm_followups` sent today for this lead; `fu_last_at`
- `inbound_msg_count`; `single_bubble` = inbound_msg_count == 1

### Priority tiers (Group 5)

| Tier | Triggers (any) |
|---|---|
| **P1 Critical** | `never_responded` · `awaiting_sales_reply_min > 10` · asked price but no follow-through |
| **P2 High** | `awaiting_customer_reply_min > 60` AND no FU sent since · `lead_temperature='hot'` & not closing & FU cycle incomplete |
| **P3 Monitor** | `single_bubble` · still asking / no clear buying signal · `awaiting_customer_reply_min` under the P2 threshold |

Thresholds (10 min, 60 min) are constants at the top of the route — easy to tune.

### Group label (for filtering)

- **Sales Response Risk** (Grup 1): `never_responded` or `last_is_inbound`
- **Follow Up Customer** (Grup 2): `awaiting_customer_reply_min` set / FU incomplete / `single_bubble`
- **Lead Stuck** (Grup 3, lite): has `root_cause_tag` or `funnel_stage_lost` from existing analysis

## UI — queue page

One page. Default view = **Priority Queue**: all stuck leads, sorted P1 → P3, then by
longest-waiting. A filter strip toggles **All / Sales Response Risk / Follow Up / Lead
Stuck**, plus a per-sales filter. Auto-refresh every ~60s + manual refresh button.

Each lead is a dense row (no sea of tiny cards):

```
🔴 P1 · Bunga Melati · PIC: Rina · masuk 14:03 · last(cust): "harganya berapa kak?"
       · belum dibalas 18 mnt · status: active · [tanya harga]   [Chat][Assign][Ack][▾ Diagnosa]
```

Row fields: priority badge, customer name, sales PIC, lead-in time, last message
(direction-aware), duration signal, status, root-cause chip (if tagged), action buttons.

**[▾ Diagnosa]** expands the AI Diagnosis panel inline (below). **Ack**/**Resolve** removes
the lead from the queue until a new inbound customer message re-opens it.

## AI Diagnosis + supervisor action loop

The expand panel calls **analyst-report Tier A on-demand** (cached; reused when the chat
hasn't changed). It renders the existing Tier A fields as:

- **AI Diagnosis** (narrative)
- **Root Issue** (customer / sales-handling / offer / process)
- **Suggested Action**
- **Suggested Script**

Supervisor actions:

| Action | Effect |
|---|---|
| **Chat Sekarang** | link to `/lotus-inbox/[id]` |
| **Assign Ulang** | existing assign endpoint |
| **Minta FU** | logs a `request_fu` action (notifies sales — notification wiring is light/Phase-2) |
| **Ack** | "analisa sesuai" — logs + hides from queue |
| **Resolve** | "sudah ditindaklanjuti" — logs + hides from queue |
| **Revisi Analisa AI** | form: alasan sebenarnya + kategori issue benar (from taxonomy) + catatan sales + status akhir — stored as a correction label |

## Data model

New table:

```
crm_lead_supervisor_actions (
  id                   bigserial primary key,
  lotus_id             text not null,
  staff_id             int not null,            -- supervisor who acted
  action               text not null,           -- ack | resolve | reassign | request_fu | revise_ai
  note                 text,
  corrected_root_cause text,                    -- when action='revise_ai'
  corrected_reason     text,                    -- when action='revise_ai'
  final_status         text,                    -- when action='revise_ai'
  created_at           timestamptz default now()
)
```

`crm_lotus_state` gets a lightweight flag pair so the queue can hide ack'd/resolved leads
until re-opened:

```
supervisor_ack_at      timestamptz,
supervisor_ack_by      int
```

A lead is hidden when `supervisor_ack_at` is set AND no inbound message has arrived after
it; a newer inbound clears it from "hidden" (computed in the scan query, not by mutating
state).

Every `revise_ai` row is the **training data** for the Phase-2 auto-learning loop —
collected from day one even though auto-learning is deferred.

## Deferred to Phase 2 (YAGNI for MVP)

- Full Group-3 issue-bucket taxonomy expansion (MVP shows existing `root_cause_tag` only).
- Auto-learning: feeding `revise_ai` corrections back into the model/prompt.
- Real-time Socket.io push (MVP = 60s auto-refresh).
- Background pre-warming of AI Diagnosis for top-N priority leads (existing nightly Tier-A
  cron stays as-is).
- Exact FU-cycle numbering (FU 1 / 2 / 3). MVP shows `fu_today` count + last FU; precise
  cycle staging needs new follow-up tracking.
- Rich "Minta FU" notification delivery to sales (MVP logs the action only).

## Out of scope

- Changes to the existing agent-centric `/supervisor` page.
- New AI models or changes to the analyst-report prompt.
