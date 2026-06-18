# Supervisor Control Revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Supervisor Control panel up to the Portable Build Brief — adding Sales Janji Belum Balik, FU Hari H 3-cycle, few-shot self-improving diagnosis, structured 5-step review, Action Tracker, and Daily Recap — on the existing `crm_lotus_state` + lotus-DB foundation.

**Architecture:** Backend = Express routes (`backend/routes/supervisorControl.js`) + pure services, two databases (`db/postgres` = crm_*, `db/lotus` = read-only contacts/messages mirror, no cross-JOIN). Diagnosis via Gemini 2.5 Flash (`services/analystReport.js`). Frontend = Next.js Pages Router (`frontend/src/pages/supervisor-control/`). Spec: `docs/superpowers/specs/2026-06-18-supervisor-control-revamp-design.md`.

**Tech Stack:** Node/Express, PostgreSQL (pg), `@google/generative-ai`, Jest (`jest --runInBand`, tests in `backend/__tests__/`), Next.js Pages Router + Tailwind, SWR.

**Conventions locked from existing code:**
- Guard: `router.use(requireStaff)` then `if (req.staff?.role !== 'admin') return res.status(403)`.
- `req.staff.staff_id` is the actor id.
- Human-staff outbound = `messages.direction='outbound' AND cs_id IS NOT NULL`. Outbound `cs_id IS NULL` = AI/auto-reply.
- `messages.received_at` is now TZ-correct (backfilled 2026-06-18). Use it for all timing.
- Migration files: `backend/migrations/NNN_name.sql`, idempotent (`IF NOT EXISTS`). Next free numbers: **037, 038**.
- Pure modules get unit tests (see `__tests__/supervisorPriority.test.js`, `stuckGroup.test.js`, `lotusFollowup.test.js`, `analystReportPrompt.test.js`).

---

## Phase 1 — Migrations (data model)

### Task 1: Migration 037 — training examples table

**Files:**
- Create: `backend/migrations/037_ai_training_examples.sql`
- Test: `backend/__tests__/migrations.test.js` (existing; it applies all migrations — no new test code, just ensure file parses)

- [ ] **Step 1: Write the migration**

```sql
-- 037_ai_training_examples.sql
-- Few-shot self-improving knowledge base for stuck-lead diagnosis.
CREATE TABLE IF NOT EXISTS crm_ai_training_examples (
  id BIGSERIAL PRIMARY KEY,
  case_pattern TEXT NOT NULL,
  category VARCHAR(64) NOT NULL,
  subtype  VARCHAR(96),
  analysis TEXT NOT NULL,
  suggested_action TEXT,
  suggested_script TEXT,
  source VARCHAR(32) NOT NULL DEFAULT 'manual_entry',
  source_action_id BIGINT,
  created_by INT REFERENCES staff_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  usage_count INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  CONSTRAINT chk_training_category CHECK (category IN ('customer','sales_handling','offer','process'))
);
CREATE INDEX IF NOT EXISTS idx_training_active_category
  ON crm_ai_training_examples (active, category, last_used_at DESC NULLS LAST);
```

- [ ] **Step 2: Apply and verify**

Run: `cd backend && npm run migrate`
Expected: applies 037 without error. Verify: `psql $PG -c "\d crm_ai_training_examples"` shows the table.
(If `npm run migrate` crashes mid-stream per known drift, apply directly: `psql "$DATABASE_URL" -f migrations/037_ai_training_examples.sql`.)

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/037_ai_training_examples.sql
git commit -m "feat(supervisor-control): migration 037 ai training examples"
```

### Task 2: Migration 038 — structured supervisor review fields

**Files:**
- Create: `backend/migrations/038_supervisor_review_fields.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 038_supervisor_review_fields.sql
-- Per-lead structured supervisor review state (drives Action Tracker + Daily Recap).
ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS supervisor_agree_with_ai BOOLEAN,
  ADD COLUMN IF NOT EXISTS supervisor_todo          TEXT,
  ADD COLUMN IF NOT EXISTS supervisor_solved        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS supervisor_outcome       VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_lotus_state_review
  ON crm_lotus_state (supervisor_solved, supervisor_ack_at);
```

- [ ] **Step 2: Apply and verify** — same as Task 1 (`npm run migrate` or direct psql). Verify the 4 columns exist on `crm_lotus_state`.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/038_supervisor_review_fields.sql
git commit -m "feat(supervisor-control): migration 038 structured review fields"
```

---

## Phase 2 — Detection services (pure, TDD)

These are pure SQL-builder + classifier modules with no DB calls in the unit, so they test fast. They export (a) a `*Sql()` string builder and (b) a row-mapping/classification helper. The route calls `lotus.query(SQL, params)` then the mapper.

### Task 3: `salesPromise.js` — promise regex + window filter

**Files:**
- Create: `backend/services/salesPromise.js`
- Test: `backend/__tests__/salesPromise.test.js`

- [ ] **Step 1: Write the failing test**

```js
const { PROMISE_RE, mapPromiseRow, hoursSince } = require('../services/salesPromise');

describe('salesPromise', () => {
  test('PROMISE_RE matches the canonical acceptance case', () => {
    const body = 'Baik ini sedang kami ajukan dlu ya ka, nanti klo sudah keluar harga nya kami infokan kembali';
    expect(PROMISE_RE.test(body)).toBe(true);
  });
  test('PROMISE_RE ignores a plain greeting', () => {
    expect(PROMISE_RE.test('Halo kak, ada yang bisa dibantu?')).toBe(false);
  });
  test('mapPromiseRow computes hours_since_promise and trims body', () => {
    const now = new Date('2026-06-18T10:00:00Z');
    const row = { lotus_id: 'x1', cust_name: 'A', assign_to_user_name: 'Wawa',
      promise_at: '2026-06-18T04:00:00Z', promise_body: 'x'.repeat(300) };
    const out = mapPromiseRow(row, now);
    expect(out.hours_since_promise).toBe(6);
    expect(out.promise_body.length).toBe(240);
    expect(out.lotus_id).toBe('x1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest salesPromise -i`
Expected: FAIL — "Cannot find module '../services/salesPromise'".

- [ ] **Step 3: Write the implementation**

```js
// backend/services/salesPromise.js
// Detect "sales janji belum balik": a human-sales outbound commitment message
// 3h–48h old with no later human-sales reply. Runs against the lotus messages mirror.

// Bahasa Indonesia promise patterns (from brief §3.1C).
const PROMISE_RE = /(saya (ajukan|cek|info(rmasikan)?|kabari|tany|cari|coba|tanyakan|proses|kirim)|aku (ajukan|cek|info(rmasikan)?|kabari|tunggu|cari|coba|tanyakan|proses|kirim)|kami (ajukan|cek|info(rmasikan)?|kabari|cari|proses|tanyakan)|ditunggu|tunggu (sebentar|dulu|ya)|akan (saya |kami |kabari|info|cek|hubungi)|nanti (saya |kami |kabari|info|cek|hubungi)|sedang (dicek|diajukan|diproses|dicari|ditanyakan)|mohon (tunggu|nunggu|menunggu)|sabar (ya|dulu)|minta waktu)/i;

function hoursSince(ts, now) {
  if (!ts) return null;
  return Math.round(((now.getTime() - new Date(ts).getTime()) / 3600000) * 10) / 10;
}

function mapPromiseRow(row, now = new Date()) {
  return {
    lotus_id: row.lotus_id,
    cust_name: row.cust_name,
    pic_name: row.assign_to_user_name || null,
    promise_at: row.promise_at,
    promise_body: String(row.promise_body || '').slice(0, 240),
    hours_since_promise: hoursSince(row.promise_at, now),
  };
}

// SQL run against db/lotus. $1 = cust_number array of the in-scope leads.
// Latest human-sales promise per cust_number, 3h–48h ago, no later human-sales reply.
function promiseSql() {
  return `
    WITH promise_msgs AS (
      SELECT m.cust_number, m.id AS msg_id, m.received_at AS promise_at, m.body AS promise_body
      FROM messages m
      WHERE m.direction='outbound' AND m.cs_id IS NOT NULL
        AND m.cust_number = ANY($1::text[])
        AND m.received_at >= now() - interval '48 hours'
        AND m.received_at <  now() - interval '3 hours'
        AND COALESCE(m.body,'') ~* $2
    ),
    latest AS (
      SELECT DISTINCT ON (cust_number) cust_number, msg_id, promise_at, promise_body
      FROM promise_msgs ORDER BY cust_number, promise_at DESC
    )
    SELECT l.cust_number, l.promise_at, l.promise_body
    FROM latest l
    WHERE NOT EXISTS (
      SELECT 1 FROM messages m3
      WHERE m3.cust_number = l.cust_number AND m3.direction='outbound' AND m3.cs_id IS NOT NULL
        AND m3.received_at > l.promise_at
    )
    ORDER BY l.promise_at ASC;`;
}

module.exports = { PROMISE_RE, promiseSql, mapPromiseRow, hoursSince };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest salesPromise -i`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/salesPromise.js backend/__tests__/salesPromise.test.js
git commit -m "feat(supervisor-control): salesPromise detection service"
```

### Task 4: `followupHariH.js` — derive 3-cycle FU overdue from message timing

**Files:**
- Create: `backend/services/followupHariH.js`
- Test: `backend/__tests__/followupHariH.test.js`

Cycle model (derived, no outcomes table). Inputs per lead: `first_inbound_at`, and the
ordered list of human-sales FU outbound timestamps **today** (`fu_times`, ascending). SLA:
cycle 1 due 2h after first inbound; cycle 2 due 4h after the cycle-1 FU; cycle 3 due 8h after
the cycle-2 FU. `expected_cycle` = the next cycle that is overdue and not yet done.

- [ ] **Step 1: Write the failing test**

```js
const { expectedCycle } = require('../services/followupHariH');

const H = (n) => new Date(`2026-06-18T0${n}:00:00Z`); // helper, 0–9h
describe('followupHariH.expectedCycle', () => {
  const now = new Date('2026-06-18T09:30:00Z');
  test('cycle 1 overdue: inbound >2h ago, no FU yet', () => {
    expect(expectedCycle({ first_inbound_at: H(6), fu_times: [] }, now)).toBe(1);
  });
  test('cycle 1 not yet due: inbound <2h ago', () => {
    const recent = new Date('2026-06-18T08:00:00Z'); // 1.5h before now
    expect(expectedCycle({ first_inbound_at: recent, fu_times: [] }, now)).toBe(null);
  });
  test('cycle 2 overdue: cycle-1 FU done >4h ago, no cycle-2', () => {
    expect(expectedCycle({ first_inbound_at: H(1), fu_times: [H(3)] }, now)).toBe(2);
  });
  test('cycle 3 overdue: two FUs, second >8h... bounded same-day so use 1h scale', () => {
    const t1 = new Date('2026-06-18T00:30:00Z');
    const t2 = new Date('2026-06-18T01:00:00Z');
    const late = new Date('2026-06-18T10:00:00Z'); // >8h after t2
    expect(expectedCycle({ first_inbound_at: new Date('2026-06-17T23:00:00Z'), fu_times: [t1, t2] }, late)).toBe(3);
  });
  test('all cycles done recently: no expected cycle', () => {
    const t = [new Date('2026-06-18T09:00:00Z'), new Date('2026-06-18T09:10:00Z'), new Date('2026-06-18T09:20:00Z')];
    expect(expectedCycle({ first_inbound_at: H(6), fu_times: t }, now)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest followupHariH -i`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// backend/services/followupHariH.js
// Derive a 3-cycle "follow up hari H" overdue signal purely from message timing.
// No outcomes table: cycles are counted from human-sales FU outbound timestamps today.

const HOURS = (h) => h * 3600000;
const SLA = { c1: HOURS(2), c2: HOURS(4), c3: HOURS(8) }; // tunable per SLA

// lead: { first_inbound_at, fu_times: Date[] ascending (human-sales outbound today) }
// Returns 1 | 2 | 3 | null (next overdue cycle).
function expectedCycle(lead, now = new Date()) {
  const t = (x) => (x ? new Date(x).getTime() : null);
  const inbound = t(lead.first_inbound_at);
  const fu = (lead.fu_times || []).map(t).filter(Boolean).sort((a, b) => a - b);
  const n = now.getTime();
  if (!inbound) return null;
  // cycle 3: 2 FUs done, second one older than 8h, no 3rd
  if (fu.length >= 2 && n - fu[1] > SLA.c3 && fu.length < 3) return 3;
  // cycle 2: 1 FU done, older than 4h, no 2nd
  if (fu.length >= 1 && n - fu[0] > SLA.c2 && fu.length < 2) return 2;
  // cycle 1: no FU yet, inbound older than 2h
  if (fu.length === 0 && n - inbound > SLA.c1) return 1;
  return null;
}

module.exports = { expectedCycle, SLA };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest followupHariH -i`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/followupHariH.js backend/__tests__/followupHariH.test.js
git commit -m "feat(supervisor-control): followupHariH 3-cycle derivation"
```

### Task 5: Sub-section classifiers for Group 1/2 (pure)

**Files:**
- Create: `backend/services/supervisorSubsections.js`
- Test: `backend/__tests__/supervisorSubsections.test.js`

Pure functions that take an enriched lead (same shape the `/panel` loop already builds) and
return booleans for each sub-section, plus the priority sub-item bucket.

- [ ] **Step 1: Write the failing test**

```js
const S = require('../services/supervisorSubsections');

describe('supervisorSubsections', () => {
  test('customerWaiting: customer waited > 10 min', () => {
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 22, last_in_after_out: true })).toBe(true);
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 5, last_in_after_out: true })).toBe(false);
  });
  test('slowFirstResponse split by no_reply_yet', () => {
    expect(S.slowFirstResponse({ first_response_lag_min: null, no_reply_yet: true })).toBe('p1');
    expect(S.slowFirstResponse({ first_response_lag_min: 5, no_reply_yet: false })).toBe('p3');
    expect(S.slowFirstResponse({ first_response_lag_min: 0.5, no_reply_yet: false })).toBe(null);
  });
  test('customerGhost: sales replied last, ghost 1–24h', () => {
    expect(S.isCustomerGhost({ ghost_hours: 5 })).toBe(true);
    expect(S.isCustomerGhost({ ghost_hours: 0.5 })).toBe(false);
    expect(S.isCustomerGhost({ ghost_hours: 30 })).toBe(false);
  });
  test('bubbleChat: 1 inbound, short body, >1h', () => {
    expect(S.isBubbleChat({ inbound_count: 1, last_in_len: 20, awaiting_customer_reply_min: 90 })).toBe(true);
    expect(S.isBubbleChat({ inbound_count: 3, last_in_len: 20, awaiting_customer_reply_min: 90 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest supervisorSubsections -i`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// backend/services/supervisorSubsections.js
// Pure sub-section classifiers for Supervisor Control Group 1 & 2.

function isCustomerWaiting(lead) {
  return !!lead.last_in_after_out && (lead.awaiting_sales_reply_min || 0) > 10;
}
// 'p1' (no reply yet), 'p3' (slow but replied), or null (fast enough).
function slowFirstResponse(lead) {
  if (lead.no_reply_yet) return 'p1';
  if (lead.first_response_lag_min != null && lead.first_response_lag_min > 1) return 'p3';
  return null;
}
function isCustomerGhost(lead) {
  const h = lead.ghost_hours;
  return h != null && h >= 1 && h < 24;
}
function isBubbleChat(lead) {
  return Number(lead.inbound_count) === 1
    && (lead.last_in_len || 0) < 50
    && (lead.awaiting_customer_reply_min || 0) > 60;
}

module.exports = { isCustomerWaiting, slowFirstResponse, isCustomerGhost, isBubbleChat };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest supervisorSubsections -i`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/supervisorSubsections.js backend/__tests__/supervisorSubsections.test.js
git commit -m "feat(supervisor-control): pure sub-section classifiers"
```

---

## Phase 3 — Extend `GET /panel`

### Task 6: Enrich the panel query + wire sub-sections

**Files:**
- Modify: `backend/routes/supervisorControl.js` (the `/panel` handler, lines 73–177)
- Test: `backend/__tests__/supervisorControlPanel.test.js` (extend)

The existing query already produces `inbound_count`, `last_outbound_at`, `first_inbound_at`,
`first_outbound_at`, `fu_count_today`. Add three LATERAL columns and one promise pass.

- [ ] **Step 1: Add enrichment columns to the panel SQL**

In the `SELECT` of the `/panel` query (after `ft`), add LATERALs:

```sql
       , COALESCE(lib.len, 0) AS last_in_len
       , gh.last_out_human AS last_out_human_at
       , lia.last_in_at AS last_in_at
```
and in the FROM chain:
```sql
       LEFT JOIN LATERAL (SELECT length(COALESCE(m.body,'')) AS len FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='inbound'
         ORDER BY m.received_at DESC NULLS LAST, id DESC LIMIT 1) lib ON true
       LEFT JOIN LATERAL (SELECT MAX(m.received_at) AS last_out_human FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.cs_id IS NOT NULL) gh ON true
       LEFT JOIN LATERAL (SELECT MAX(m.received_at) AS last_in_at FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='inbound') lia ON true
       LEFT JOIN LATERAL (SELECT array_agg(m.received_at ORDER BY m.received_at) AS fu FROM messages m
         WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.cs_id IS NOT NULL
           AND m.received_at::date = now()::date) fud ON true
```
Add `fud.fu AS fu_times_today` to the SELECT list.

- [ ] **Step 2: Compute sub-section fields in the per-lead loop**

In the `for (const c of contacts)` loop, after `const fu = followupState(...)`, add:

```js
    const hoursSince = (ts) => ts ? (now.getTime() - new Date(ts).getTime()) / 3600000 : null;
    const lastInAfterOut = c.last_in_at && (!c.last_out_human_at || new Date(c.last_in_at) > new Date(c.last_out_human_at));
    const ghostHours = (c.last_out_human_at && (!c.last_in_at || new Date(c.last_in_at) < new Date(c.last_out_human_at)))
      ? hoursSince(c.last_out_human_at) : null;
    const expCycle = require('../services/followupHariH').expectedCycle(
      { first_inbound_at: firstInbound, fu_times: c.fu_times_today || [] }, now);
```
Attach to the pushed item (include the exact fields the Phase-2 classifiers read, so the
shapes match): `last_in_len: Number(c.last_in_len)||0, last_in_after_out: lastInAfterOut,
ghost_hours: ghostHours, expected_cycle: expCycle, no_reply_yet: lead.never_responded &&
!!c.first_inbound_at, first_response_lag_min: lead.first_response_lag_min,
awaiting_sales_reply_min: lead.awaiting_sales_reply_min, awaiting_customer_reply_min:
lead.awaiting_customer_reply_min, inbound_count: Number(c.inbound_count)||0`.

- [ ] **Step 3: Build the new grouped response**

After the existing `items` build, replace the response assembly with sub-section buckets using the Phase-2 classifiers and `salesPromise`. Add near the top of the handler:

```js
const S = require('../services/supervisorSubsections');
const { promiseSql, PROMISE_RE, mapPromiseRow } = require('../services/salesPromise');
```
Run the promise pass (scope to in-window cust_numbers):
```js
    const custNumbers = contacts.map((c) => c.cust_number).filter(Boolean);
    let promiseByCust = new Map();
    if (custNumbers.length) {
      const { rows: pr } = await lotus.query(promiseSql(), [custNumbers, PROMISE_RE.source]);
      const nameByCust = new Map(contacts.map((c) => [c.cust_number, c]));
      promiseByCust = new Map(pr.map((row) => {
        const c = nameByCust.get(row.cust_number) || {};
        return [row.cust_number, mapPromiseRow({ ...row, lotus_id: c.lotus_id, cust_name: c.cust_name, assign_to_user_name: c.assign_to_user_name }, now)];
      }));
    }
```
Assemble:
```js
    const responseRisk = { customerWaiting: [], slowFirstResponse: [], salesPromiseBroken: [] };
    const followUp = { customerGhost: [], bubbleChat: [], pendingFuByCycle: { 1: [], 2: [], 3: [] } };
    const leadStuckByCategory = { A: [], B: [], C: [], D: [], uncategorized: [] };
    for (const i of items) {
      if (S.isCustomerWaiting(i)) responseRisk.customerWaiting.push(i);
      const sfr = S.slowFirstResponse(i); if (sfr) responseRisk.slowFirstResponse.push(i);
      if (S.isCustomerGhost(i)) followUp.customerGhost.push(i);
      if (S.isBubbleChat(i)) followUp.bubbleChat.push(i);
      if (i.expected_cycle) followUp.pendingFuByCycle[i.expected_cycle].push(i);
      const cust = byLotus.get(i.lotus_id);
      const p = cust && promiseByCust.get(cust.cust_number);
      if (p) responseRisk.salesPromiseBroken.push({ ...i, ...p });
      if (i.groups.includes('lead_stuck')) {
        if (i.stuck_bucket) leadStuckByCategory[i.stuck_bucket].push(i);
        else leadStuckByCategory.uncategorized.push(i);
      }
    }
```
(`byLotus` = `new Map(contacts.map(c => [c.lotus_id, c]))`.)

- [ ] **Step 4: Compute priority counts + return new shape**

```js
    const p1Items = {
      customerWaitingCritical: responseRisk.customerWaiting.length,
      leadNoReply: responseRisk.slowFirstResponse.filter((i) => i.no_reply_yet).length,
      salesPromiseBroken: responseRisk.salesPromiseBroken.length,
    };
    const p2Items = {
      customerGhost: followUp.customerGhost.length,
      fuCycleIncomplete: followUp.pendingFuByCycle[1].length + followUp.pendingFuByCycle[2].length + followUp.pendingFuByCycle[3].length,
      leadStuck: ['A','B','C','D','uncategorized'].reduce((a,k)=>a+leadStuckByCategory[k].length,0),
    };
    const p3Items = {
      bubbleChat: followUp.bubbleChat.length,
      slowFirstResponseMild: responseRisk.slowFirstResponse.filter((i) => !i.no_reply_yet).length,
    };
    const sum = (o) => Object.values(o).reduce((a,b)=>a+b,0);
    const CAP = 50;
    const cap = (arr) => arr.slice(0, CAP);
    res.json({
      responseRisk: { customerWaiting: cap(responseRisk.customerWaiting), slowFirstResponse: cap(responseRisk.slowFirstResponse), salesPromiseBroken: cap(responseRisk.salesPromiseBroken) },
      followUp: { customerGhost: cap(followUp.customerGhost), bubbleChat: cap(followUp.bubbleChat),
        pendingFuByCycle: { 1: cap(followUp.pendingFuByCycle[1]), 2: cap(followUp.pendingFuByCycle[2]), 3: cap(followUp.pendingFuByCycle[3]) } },
      leadStuckByCategory: Object.fromEntries(Object.entries(leadStuckByCategory).map(([k,v])=>[k,cap(v)])),
      priority: { p1: sum(p1Items), p1Items, p2: sum(p2Items), p2Items, p3: sum(p3Items), p3Items, total: sum(p1Items)+sum(p2Items)+sum(p3Items) },
      generatedAt: new Date().toISOString(),
      // keep legacy keys for backward-compat during FE migration:
      priority_queue: priority_queue.slice(0, CAP), groups, counts: { /* existing */ },
    });
```

- [ ] **Step 5: Extend the panel test**

In `backend/__tests__/supervisorControlPanel.test.js`, add an assertion that the response has `responseRisk.salesPromiseBroken`, `followUp.pendingFuByCycle`, `leadStuckByCategory.uncategorized`, and `priority.p1Items`. Mock `lotus.query`/`pg.query` following the existing test's mocking pattern.

- [ ] **Step 6: Run + commit**

Run: `cd backend && npx jest supervisorControlPanel -i` → PASS.
```bash
git add backend/routes/supervisorControl.js backend/__tests__/supervisorControlPanel.test.js
git commit -m "feat(supervisor-control): panel sub-sections + promise + FU-cycle + priority items"
```

---

## Phase 4 — Diagnosis few-shot + review endpoints

### Task 7: `trainingExamples.js` service (CRUD + selection + createFromRevision)

**Files:**
- Create: `backend/services/trainingExamples.js`
- Test: `backend/__tests__/trainingExamples.test.js`

- [ ] **Step 1: Write the failing test** (selection ordering is the pure-testable bit)

```js
const { pickExamples, formatExamplesBlock } = require('../services/trainingExamples');
describe('trainingExamples', () => {
  const rows = [
    { id:1, category:'customer', case_pattern:'a', analysis:'A', usage_count:5, last_used_at:'2026-06-10' },
    { id:2, category:'customer', case_pattern:'b', analysis:'B', usage_count:1, last_used_at:'2026-06-17' },
    { id:3, category:'customer', case_pattern:'c', analysis:'C', usage_count:0, last_used_at:null },
    { id:4, category:'sales_handling', case_pattern:'d', analysis:'D', usage_count:2, last_used_at:'2026-06-15' },
  ];
  test('max 2 per category, limit total', () => {
    const out = pickExamples(rows, { limit: 5, perCategory: 2 });
    const cust = out.filter((r) => r.category === 'customer');
    expect(cust.length).toBe(2);
    expect(out.length).toBe(3); // 2 customer + 1 sales
  });
  test('formatExamplesBlock empty → empty string', () => {
    expect(formatExamplesBlock([])).toBe('');
  });
  test('formatExamplesBlock includes case + analysis', () => {
    const b = formatExamplesBlock([rows[0]]);
    expect(b).toContain('Case: a');
    expect(b).toContain('Analisa: A');
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd backend && npx jest trainingExamples -i` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// backend/services/trainingExamples.js
const pg = require('../db/postgres');

// Pure: choose ≤perCategory per category, ≤limit total, prefer high usage + recent.
function pickExamples(rows, { limit = 5, perCategory = 2 } = {}) {
  const sorted = [...rows].sort((a, b) =>
    (b.usage_count - a.usage_count) ||
    (new Date(b.last_used_at || 0) - new Date(a.last_used_at || 0)));
  const perCat = {}; const out = [];
  for (const r of sorted) {
    perCat[r.category] = (perCat[r.category] || 0);
    if (perCat[r.category] >= perCategory) continue;
    perCat[r.category]++; out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function formatExamplesBlock(examples) {
  if (!examples.length) return '';
  const lines = examples.map((e, i) =>
    `Contoh ${i + 1}:\nCase: ${e.case_pattern}\nKategori: ${e.category}${e.subtype ? ` (${e.subtype})` : ''}\nAnalisa: ${e.analysis}` +
    (e.suggested_action ? `\nAction: ${e.suggested_action}` : '') +
    (e.suggested_script ? `\nScript: ${e.suggested_script}` : ''));
  return `\nCONTOH KASUS YANG SUDAH DI-REVIEW SUPERVISOR (gunakan sebagai referensi):\n\n${lines.join('\n\n')}\n`;
}

async function getActiveExamples({ limit = 5, perCategory = 2 } = {}) {
  const { rows } = await pg.query(
    `SELECT id, category, subtype, case_pattern, analysis, suggested_action, suggested_script, usage_count, last_used_at
     FROM crm_ai_training_examples WHERE active = TRUE`);
  const picked = pickExamples(rows, { limit, perCategory });
  if (picked.length) {
    await pg.query(
      `UPDATE crm_ai_training_examples SET usage_count = usage_count + 1, last_used_at = now() WHERE id = ANY($1::bigint[])`,
      [picked.map((p) => p.id)]);
  }
  return picked;
}

// category mapping: our buckets A/B/C/D ←→ brief categories
const CAT_OF_BUCKET = { A: 'customer', B: 'sales_handling', C: 'offer', D: 'process' };

async function createFromRevision({ action_id, category, subtype, analysis, suggested_action, suggested_script, created_by }) {
  if (!category || !analysis) return null;
  const { rows } = await pg.query(
    `INSERT INTO crm_ai_training_examples (case_pattern, category, subtype, analysis, suggested_action, suggested_script, source, source_action_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'supervisor_revise',$7,$8) RETURNING id`,
    [analysis.slice(0, 200), category, subtype || null, analysis, suggested_action || null, suggested_script || null, action_id || null, created_by || null]);
  return rows[0].id;
}

module.exports = { pickExamples, formatExamplesBlock, getActiveExamples, createFromRevision, CAT_OF_BUCKET };
```

- [ ] **Step 4: Run to verify pass** — `cd backend && npx jest trainingExamples -i` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/trainingExamples.js backend/__tests__/trainingExamples.test.js
git commit -m "feat(supervisor-control): trainingExamples service (few-shot selection + CRUD helpers)"
```

### Task 8: Inject few-shot examples into Tier A prompt

**Files:**
- Modify: `backend/services/analystReport.js` (`buildTierAUserPrompt` line 11, `runTierA` line 76)
- Test: `backend/__tests__/analystReportPrompt.test.js` (extend)

- [ ] **Step 1: Write failing test** — add to existing prompt test:

```js
test('buildTierAUserPrompt embeds examples block when provided', () => {
  const { buildTierAUserPrompt } = require('../services/analystReport');
  const out = buildTierAUserPrompt({ transcript: 't', msgCount: 1, inboundCount: 1,
    corrections: [], examplesBlock: '\nCONTOH KASUS: xyz\n' });
  expect(out).toContain('CONTOH KASUS: xyz');
});
```
(If `buildTierAUserPrompt` isn't exported, add it to `module.exports`.)

- [ ] **Step 2: Run to verify fail** — `cd backend && npx jest analystReportPrompt -i` → FAIL.

- [ ] **Step 3: Implement** — in `buildTierAUserPrompt`, accept `examplesBlock` and append it next to `corrBlock`:

```js
function buildTierAUserPrompt({ transcript, msgCount, inboundCount, corrections, examplesBlock = '' }) {
  const corrBlock = /* unchanged */;
  // ...existing return, change the tail to:
  return `...${corrBlock}${examplesBlock}
Transkrip (${msgCount} pesan, ${inboundCount} inbound):
${transcript}`;
}
```
In `runTierA`, accept `examplesBlock` and pass it through:
```js
async function runTierA({ transcript, msgCount, inboundCount, geminiKey, corrections, examplesBlock }) {
  // ...
  const prompt = buildTierAUserPrompt({ transcript, msgCount, inboundCount, corrections, examplesBlock });
  // ...
}
```
Ensure `module.exports` includes `buildTierAUserPrompt`.

- [ ] **Step 4: Run to verify pass** — `cd backend && npx jest analystReportPrompt -i` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/analystReport.js backend/__tests__/analystReportPrompt.test.js
git commit -m "feat(supervisor-control): inject few-shot examples into Tier A prompt"
```

### Task 9: Diagnose + review + bulk endpoints

**Files:**
- Modify: `backend/routes/supervisorControl.js` (add routes)
- Test: `backend/__tests__/supervisorControl.test.js` (extend with supertest pattern already used there)

Reuse the existing diagnose machinery: import the transcript builder + `runTierA` the same
way `cron_analyst_tier_a_prewarm.js` does (read that file for `buildTranscript`, `geminiKey =
process.env.GEMINI_API_KEY`, and the `crm_lotus_state` upsert). Wrap it in a helper
`diagnoseLead(lotus_id)` so the route and bulk share one path; pass
`examplesBlock = formatExamplesBlock(await getActiveExamples())` and the existing corrections.

- [ ] **Step 1: Add `POST /:lotus_id/diagnose`**

```js
const { getActiveExamples, formatExamplesBlock, createFromRevision, CAT_OF_BUCKET } = require('../services/trainingExamples');
// helper diagnoseLead(lotus_id) — mirror cron_analyst_tier_a_prewarm.js:
//   build transcript from lotus messages, fetch last-15 revise corrections,
//   examplesBlock = formatExamplesBlock(await getActiveExamples()),
//   runTierA(...), then upsert validated fields into crm_lotus_state.
router.post('/:lotus_id/diagnose', async (req, res, next) => {
  try { const out = await diagnoseLead(req.params.lotus_id); res.json({ ok: true, diagnosis: out }); }
  catch (e) { next(e); }
});
```

- [ ] **Step 2: Add `POST /diagnosis/:lotus_id/review` (5-step structured)**

```js
router.post('/diagnosis/:lotus_id/review', async (req, res, next) => {
  try {
    const { lotus_id } = req.params;
    const { agree_with_ai, revise_category, revise_subtype, revise_note, solved, supervisor_todo, supervisor_outcome } = req.body || {};
    if (typeof agree_with_ai !== 'boolean' || typeof solved !== 'boolean')
      return res.status(400).json({ error: 'agree_with_ai and solved required' });
    if (agree_with_ai === false && !revise_note)
      return res.status(400).json({ error: 'revise_note required when disagreeing' });

    const ins = await pg.query(
      `INSERT INTO crm_lead_supervisor_actions (lotus_id, staff_id, action, note, corrected_root_cause, corrected_reason, final_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [lotus_id, req.staff.staff_id, solved ? 'resolve' : 'ack', supervisor_todo || null,
       revise_category || null, revise_note || null, supervisor_outcome || null]);

    await pg.query(
      `UPDATE crm_lotus_state SET supervisor_agree_with_ai=$2, supervisor_todo=$3, supervisor_solved=$4,
         supervisor_outcome=$5, supervisor_ack_at=now(), supervisor_ack_by=$6 WHERE lotus_id=$1`,
      [lotus_id, agree_with_ai, supervisor_todo || null, solved, supervisor_outcome || null, req.staff.staff_id]);

    let exampleId = null;
    if (agree_with_ai === false && revise_category && revise_note) {
      exampleId = await createFromRevision({ action_id: ins.rows[0].id, category: revise_category,
        subtype: revise_subtype, analysis: revise_note, created_by: req.staff.staff_id });
    }
    res.json({ ok: true, action_id: ins.rows[0].id, training_example_id: exampleId });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Add `POST /:lotus_id/review-no-diagnose` and `POST /bulk-diagnose`**

```js
router.post('/:lotus_id/review-no-diagnose', async (req, res, next) => {
  try {
    const { lotus_id } = req.params;
    const { solved, supervisor_todo, revise_category, revise_note, supervisor_outcome } = req.body || {};
    await pg.query(
      `UPDATE crm_lotus_state SET root_cause_tag = COALESCE($2, root_cause_tag), stuck_issue = COALESCE($3, stuck_issue),
         supervisor_todo=$4, supervisor_solved=$5, supervisor_outcome=$6, supervisor_ack_at=now(), supervisor_ack_by=$7,
         analyst_report_generated_at = COALESCE(analyst_report_generated_at, now()) WHERE lotus_id=$1`,
      [lotus_id, revise_category || null, revise_note || null, supervisor_todo || null, !!solved, supervisor_outcome || null, req.staff.staff_id]);
    await pg.query(
      `INSERT INTO crm_lead_supervisor_actions (lotus_id, staff_id, action, note, corrected_root_cause, corrected_reason, final_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [lotus_id, req.staff.staff_id, solved ? 'resolve' : 'ack', supervisor_todo || null, revise_category || null, revise_note || null, supervisor_outcome || null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/bulk-diagnose', async (req, res, next) => {
  try {
    const ids = (req.body?.lotus_ids || []).slice(0, 100);
    let succeeded = 0, failed = 0; const errors = [];
    for (const id of ids) {
      try { await diagnoseLead(id); succeeded++; }
      catch (e) { failed++; errors.push({ id, error: e.message }); }
      await new Promise((r) => setTimeout(r, 200));
    }
    res.json({ processed: ids.length, succeeded, failed, errors });
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Test** — extend `supervisorControl.test.js`: assert `/diagnosis/:id/review` rejects missing `agree_with_ai` (400), and on `agree_with_ai=false`+note inserts an action and updates state (mock pg.query, assert calls). Follow the existing supertest setup in that file.

- [ ] **Step 5: Run + commit**

Run: `cd backend && npx jest supervisorControl -i` → PASS.
```bash
git add backend/routes/supervisorControl.js backend/__tests__/supervisorControl.test.js
git commit -m "feat(supervisor-control): diagnose + structured review + bulk endpoints"
```

### Task 10: Training-examples CRUD endpoints

**Files:**
- Modify: `backend/routes/supervisorControl.js`
- Test: `backend/__tests__/supervisorControl.test.js`

- [ ] **Step 1: Add routes**

```js
router.get('/training-examples', async (req, res, next) => {
  try {
    const active = req.query.active;
    const where = active === 'true' ? 'WHERE active=TRUE' : active === 'false' ? 'WHERE active=FALSE' : '';
    const { rows } = await pg.query(
      `SELECT t.*, su.full_name AS created_by_name FROM crm_ai_training_examples t
       LEFT JOIN staff_users su ON su.id=t.created_by ${where} ORDER BY t.updated_at DESC LIMIT 200`);
    const stats = await pg.query(
      `SELECT COUNT(*) FILTER (WHERE active) AS active_count,
              COUNT(*) FILTER (WHERE source='supervisor_revise') AS from_revise,
              COUNT(*) FILTER (WHERE source='manual_entry') AS from_manual,
              COALESCE(SUM(usage_count),0) AS total_usage FROM crm_ai_training_examples`);
    res.json({ items: rows, stats: stats.rows[0] });
  } catch (e) { next(e); }
});
router.post('/training-examples', async (req, res, next) => {
  try {
    const { case_pattern, category, subtype, analysis, suggested_action, suggested_script } = req.body || {};
    if (!case_pattern || !category || !analysis) return res.status(400).json({ error: 'case_pattern, category, analysis required' });
    const { rows } = await pg.query(
      `INSERT INTO crm_ai_training_examples (case_pattern, category, subtype, analysis, suggested_action, suggested_script, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'manual_entry',$7) RETURNING id`,
      [case_pattern, category, subtype || null, analysis, suggested_action || null, suggested_script || null, req.staff.staff_id]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});
router.put('/training-examples/:id', async (req, res, next) => {
  try {
    const f = req.body || {};
    await pg.query(
      `UPDATE crm_ai_training_examples SET case_pattern=COALESCE($2,case_pattern), category=COALESCE($3,category),
         subtype=$4, analysis=COALESCE($5,analysis), suggested_action=$6, suggested_script=$7,
         active=COALESCE($8,active), updated_at=now() WHERE id=$1`,
      [req.params.id, f.case_pattern||null, f.category||null, f.subtype||null, f.analysis||null,
       f.suggested_action||null, f.suggested_script||null, typeof f.active==='boolean'?f.active:null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
router.delete('/training-examples/:id', async (req, res, next) => {
  try { await pg.query(`UPDATE crm_ai_training_examples SET active=FALSE, updated_at=now() WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
```

- [ ] **Step 2: Test** — assert `POST /training-examples` 400 without required fields; 200 with them (mock pg).

- [ ] **Step 3: Run + commit**

```bash
git add backend/routes/supervisorControl.js backend/__tests__/supervisorControl.test.js
git commit -m "feat(supervisor-control): training-examples CRUD endpoints"
```

---

## Phase 5 — Action Tracker + Daily Recap endpoints

### Task 11: `GET /actions` (compliance backlog)

**Files:**
- Modify: `backend/routes/supervisorControl.js`
- Create: `backend/services/supervisorRecap.js` (pure aggregation helpers)
- Test: `backend/__tests__/supervisorRecap.test.js`

- [ ] **Step 1: Write failing test for the pure summary calc**

```js
const { summarize } = require('../services/supervisorRecap');
test('summarize computes coverage and compliance', () => {
  const leads = [
    { supervisor_solved: true,  supervisor_ack_at: 'x' },
    { supervisor_solved: false, supervisor_ack_at: 'x' },
    { supervisor_solved: false, supervisor_ack_at: null },
    { supervisor_solved: false, supervisor_ack_at: null },
  ];
  const s = summarize(leads);
  expect(s.total).toBe(4);
  expect(s.done).toBe(1);
  expect(s.reviewed_open).toBe(1);
  expect(s.not_reviewed).toBe(2);
  expect(s.compliance_pct).toBe(25);
  expect(s.coverage_pct).toBe(50);
});
```

- [ ] **Step 2: Run fail** — `cd backend && npx jest supervisorRecap -i` → FAIL.

- [ ] **Step 3: Implement `summarize`**

```js
// backend/services/supervisorRecap.js
function summarize(leads) {
  const total = leads.length;
  const done = leads.filter((l) => l.supervisor_solved).length;
  const reviewed_open = leads.filter((l) => !l.supervisor_solved && l.supervisor_ack_at).length;
  const not_reviewed = leads.filter((l) => !l.supervisor_solved && !l.supervisor_ack_at).length;
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;
  return { total, done, reviewed_open, not_reviewed, compliance_pct: pct(done), coverage_pct: pct(done + reviewed_open) };
}
module.exports = { summarize };
```

- [ ] **Step 4: Run pass** → then add the route:

```js
const { summarize } = require('../services/supervisorRecap');
router.get('/actions', async (req, res, next) => {
  try {
    const range = parseInt(req.query.range) || 30;
    const dateFrom = req.query.date_from, dateTo = req.query.date_to;
    const where = (dateFrom && dateTo)
      ? `WHERE s.updated_at >= $1 AND s.updated_at < ($2::date + 1)`
      : `WHERE s.updated_at >= now() - ($1 || ' days')::interval`;
    const params = (dateFrom && dateTo) ? [dateFrom, dateTo] : [String(range)];
    const { rows: leads } = await pg.query(
      `SELECT s.lotus_id, s.supervisor_solved, s.supervisor_ack_at, s.supervisor_ack_by, s.root_cause_tag, s.stuck_group, s.assigned_staff_id,
              su.full_name AS supervisor_name
       FROM crm_lotus_state s LEFT JOIN staff_users su ON su.id=s.supervisor_ack_by
       ${where} AND (s.stuck_group IS NOT NULL OR s.supervisor_ack_at IS NOT NULL)
       ORDER BY s.supervisor_ack_at DESC NULLS LAST LIMIT 500`, params);
    const summary = summarize(leads);
    const bySup = {};
    for (const l of leads.filter((x) => x.supervisor_ack_by)) {
      const k = l.supervisor_ack_by;
      bySup[k] = bySup[k] || { supervisor_id: k, supervisor_name: l.supervisor_name, handled: 0, done: 0, open: 0 };
      bySup[k].handled++; l.supervisor_solved ? bySup[k].done++ : bySup[k].open++;
    }
    const bySupervisor = Object.values(bySup).map((b) => ({ ...b, compliance_pct: b.handled ? Math.round((b.done/b.handled)*100) : 0 }));
    res.json({ summary: { ...summary, range_days: (dateFrom&&dateTo)?undefined:range, date_from: dateFrom, date_to: dateTo }, bySupervisor, tasks: leads.slice(0, 500) });
  } catch (e) { next(e); }
});
```

- [ ] **Step 5: Commit**

```bash
git add backend/services/supervisorRecap.js backend/__tests__/supervisorRecap.test.js backend/routes/supervisorControl.js
git commit -m "feat(supervisor-control): action tracker endpoint + summarize"
```

### Task 12: `GET /daily-recap` (match-rate + issue breakdown + bubble progress)

**Files:**
- Modify: `backend/routes/supervisorControl.js`
- Modify: `backend/services/supervisorRecap.js` (+ `matchRate`, `issueBreakdown`)
- Test: `backend/__tests__/supervisorRecap.test.js`

- [ ] **Step 1: Failing test for matchRate**

```js
const { matchRate } = require('../services/supervisorRecap');
test('matchRate = agreed/(agreed+revised), legacy null agree counts as agreed', () => {
  const rows = [
    { supervisor_agree_with_ai: true }, { supervisor_agree_with_ai: false },
    { supervisor_agree_with_ai: null, supervisor_ack_at: 'x' }, // legacy implied agree
  ];
  const m = matchRate(rows);
  expect(m.agreed).toBe(2); expect(m.revised).toBe(1); expect(m.match_pct).toBe(67);
});
```

- [ ] **Step 2: Run fail → implement**

```js
function matchRate(rows) {
  const reviewed = rows.filter((r) => r.supervisor_agree_with_ai !== undefined && (r.supervisor_agree_with_ai !== null || r.supervisor_ack_at));
  const agreed = reviewed.filter((r) => r.supervisor_agree_with_ai === true || (r.supervisor_agree_with_ai === null && r.supervisor_ack_at)).length;
  const revised = reviewed.filter((r) => r.supervisor_agree_with_ai === false).length;
  const denom = agreed + revised;
  return { reviewed_total: denom, agreed, revised, match_pct: denom ? Math.round((agreed/denom)*100) : 0 };
}
function issueBreakdown(rows) {
  const byCategory = { A:0,B:0,C:0,D:0 };
  for (const r of rows) if (r.stuck_bucket && byCategory[r.stuck_bucket] != null) byCategory[r.stuck_bucket]++;
  return { byCategory, total: rows.length };
}
module.exports = { summarize, matchRate, issueBreakdown };
```

- [ ] **Step 3: Add the route** — query `crm_lotus_state` for the date (`supervisor_ack_at::date = $1` or `analyst_report_generated_at::date = $1`), build `issueBreakdown` (map stuck_group→bucket), `matchRate`, per-supervisor actions from `crm_lead_supervisor_actions` for that date, and bubble-chat progress (leads with `inbound_count=1` short body and their outcome: closed/fu_done/sales_replied/lost/no_action derived from `supervisor_outcome` + later messages). Return the brief §5.3 shape.

- [ ] **Step 4: Run + commit**

```bash
git add backend/services/supervisorRecap.js backend/__tests__/supervisorRecap.test.js backend/routes/supervisorControl.js
git commit -m "feat(supervisor-control): daily recap endpoint (match-rate + breakdown + bubble progress)"
```

---

## Phase 6 — Frontend revamp

Existing components in `frontend/src/components/supervisor-control/`: `PriorityQueue.jsx`,
`GroupSection.jsx`, `LeadCard.jsx`, `DiagnosisPanel.jsx`. Page:
`frontend/src/pages/supervisor-control/index.js`. SWR fetcher + `api()` helper from
`@/lib/api` (note: `api(path,{method,body})` stringifies body internally — pass an object).
Visual reference: the 9 screenshots in `img/supervisor_control/`.

### Task 13: Tailwind `xs` breakpoint

**Files:** Modify `frontend/tailwind.config.js`

- [ ] **Step 1:** add `screens: { xs: '420px', ...defaultTheme.screens }` under `theme.extend` (or `theme.screens` per existing config). **Step 2:** `npm run build` compiles. **Step 3:** commit.

### Task 14: `SubSection` component (icon + situation + action hint)

**Files:**
- Create: `frontend/src/components/supervisor-control/SubSection.jsx`

- [ ] **Step 1: Implement** (props: `icon`, `title`, `count`, `situation`, `actionHint`, `children`)

```jsx
export default function SubSection({ icon, title, count, situation, actionHint, children }) {
  return (
    <div className="border-t border-slate-100">
      <div className="px-4 sm:px-6 py-3 bg-amber-50/40">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 shrink-0 rounded-full bg-brand-50 inline-flex items-center justify-center text-lg">{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-slate-800 text-sm uppercase tracking-wide">{title}</h4>
              {count > 0 && <span className="text-xs font-bold text-white bg-rose-500 rounded-full px-2 py-0.5">{count}</span>}
            </div>
            {situation && <p className="text-sm text-slate-600 mt-0.5">{situation}</p>}
            {actionHint && <p className="text-sm text-brand-700 mt-0.5">→ {actionHint}</p>}
          </div>
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2:** `npm run build`. **Step 3:** commit.

### Task 15: `LeadRow` (extend LeadCard) + actions

**Files:** Create `frontend/src/components/supervisor-control/LeadRow.jsx`

- [ ] **Step 1: Implement** — props `lead`, `variant` ('waiting'|'ghost'|'stuck'|'promise'), `onReview`, `onReviewDx`, `onCopy`. Renders: colored dot, `cust_name`·`pic_name`, last-message preview (truncate 80), `Stage {lead_status}` + `Temp {lead_temperature}`, a right-aligned badge (`Tunggu {min}` / `Ghost {h}j` / `{hours_since_promise}j` / `{lead_status} {age}`), and buttons. **Chat** opens the Lotus chat:

```jsx
<a href={`/lotus-inbox/${encodeURIComponent(lead.lotus_id)}`} target="_blank" rel="noreferrer"
   className="text-xs px-3 py-2 rounded-md bg-slate-900 text-white inline-flex items-center gap-1">💬 Chat</a>
```
For `variant==='promise'`: highlight `lead.promise_body` in an amber band + `Salin remind` copying `Halo Kak ${lead.cust_name||''}, mohon maaf — update untuk request sebelumnya ya kak 🙏`. For `variant==='stuck'`: show **Review Dx** (calls `onReviewDx(lead)`) and **Review** (calls `onReview(lead)`).

- [ ] **Step 2:** build. **Step 3:** commit.

### Task 16: `ReviewForm` (5-step structured)

**Files:** Create `frontend/src/components/supervisor-control/ReviewForm.jsx`

- [ ] **Step 1: Implement** — controlled form, state: `agree` (bool|null), `category`, `subtype`, `note`, `solved` (bool|null), `todo`, `outcome`. Layout matches screenshot 08.49.03(2): (1) Setuju/Tidak setuju radio; (2) if Tidak: category dropdown [customer/sales_handling/offer/process] + subtype input + note textarea; (3) Ya sudah solve / Belum radio; (4) todo textarea (required to enable submit); (5) outcome radio [closing|lost|parked|still_fu|unknown]. Submit:

```js
await api(`/api/supervisor-control/diagnosis/${lead.lotus_id}/review`, { method: 'POST', body: {
  agree_with_ai: agree, revise_category: category, revise_subtype: subtype, revise_note: note,
  solved, supervisor_todo: todo, supervisor_outcome: outcome } });
```
Disable submit until `agree!=null && solved!=null && todo.trim()` (and `note` when `agree===false`). On success call `onDone()` (parent mutates SWR). 

- [ ] **Step 2:** build. **Step 3:** commit.

### Task 17: `CycleSplit`, `AITrainingCard`, `ActionTrackerCard`, `DailyRecapCard`

**Files:** Create four components in `frontend/src/components/supervisor-control/`.

- [ ] **Step 1: `CycleSplit.jsx`** — props `{1:[],2:[],3:[]}`; three labeled columns ("Cycle 1/2/3 overdue") each rendering `LeadRow variant="ghost"`.
- [ ] **Step 2: `AITrainingCard.jsx`** — SWR `/api/supervisor-control/training-examples?active=true`; hero stats (active, from_revise, from_manual, total_usage); list (case_pattern preview, category chip, "Used N×", Edit/Disable); "+ Tambah Manual" modal with 6 fields → `POST /training-examples`. Edit → `PUT`, Disable → `DELETE`.
- [ ] **Step 3: `ActionTrackerCard.jsx`** — date presets (7/30/90) + custom range; SWR `/api/supervisor-control/actions`; KPI boxes (Total/Solved/In progress/Belum direview), compliance bar, filter pills, per-supervisor table, backlog list with "Review sekarang" → opens `ReviewForm` inline (uses `review-no-diagnose` when no dx).
- [ ] **Step 4: `DailyRecapCard.jsx`** — date presets + picker; SWR `/api/supervisor-control/daily-recap?date=`; **match-rate 4xl** prominent ("Match analisa AI vs Supervisor: N%"); 2-col issue/action breakdown; Bubble Chat Progress 5-box (total/closing/fu_done/sales_replied/lost) + conversion funnel line.
- [ ] **Step 5:** build after each; **commit** per component.

### Task 18: `PrioritySummary` (sticky) + rewrite page `index.js`

**Files:**
- Create: `frontend/src/components/supervisor-control/PrioritySummary.jsx`
- Modify: `frontend/src/pages/supervisor-control/index.js`

- [ ] **Step 1: `PrioritySummary.jsx`** — sticky dark bar (`sticky top-0 z-20 bg-slate-900 text-white`). Props `priority`, `onJump(group)`. Three boxes P1(red)/P2(amber)/P3(blue) with main number + sub-item line (e.g. `18 wait >10m · 4 belum dibalas · 16 janji belum balik`), plus Total on the right. xs: collapse to 2-row.

- [ ] **Step 2: Rewrite `index.js`** to the spec §5 layout: admin gate (reuse existing `/api/auth/me` check), SWR `/api/supervisor-control/panel?scope` `refreshInterval: 60_000`, `forceOpenSignal` per group on jump. Compose: `<PrioritySummary>` → `<GroupCard "1. Sales Response Risk" P1>` with three `<SubSection>` (Customer Menunggu Balas / Slow First Response / Sales Janji Belum Balik) → `<GroupCard "2. Follow Up Customer" P2>` (Customer Belum Balas Sales / Bubble Chat 1× / Follow Up Hari H w/ `<CycleSplit>`) → `<GroupCard "3. Lead Stuck Belum Closing" P2>` (A/B/C/D + Belum Di-Diagnose w/ Bulk button) → `<AITrainingCard>` → `<ActionTrackerCard>` → `<DailyRecapCard>`. Wire `onReview`→ReviewForm, `onReviewDx`→DiagnosisPanel (existing). After any action, `mutate()`.

- [ ] **Step 3: Build + smoke** — `cd frontend && npm run build` compiles; open `/supervisor-control` (after deploy) and verify groups render, sticky bar, jump, Chat → `/lotus-inbox/[lotus_id]`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/supervisor-control/ frontend/src/pages/supervisor-control/index.js
git commit -m "feat(supervisor-control): revamp UI (priority bar, subsections, review, tracker, recap)"
```

---

## Phase 7 — Polish + verify

### Task 19: Mobile + acceptance pass

- [ ] LeadRow stacks on mobile (badge → next line); GroupCard padding smaller < 640px; DiagnosisPanel/ReviewForm usable on mobile.
- [ ] Run full backend suite: `cd backend && npm test` → all green.
- [ ] Manual acceptance against spec §7: promise case matches the canonical sentence; FU cycles bucket correctly; `agree_with_ai=false`+note → training example created (check `crm_ai_training_examples`); bulk diagnose 30 leads no rate-limit; Daily Recap match-rate 4xl; Chat opens `/lotus-inbox/[lotus_id]`.
- [ ] Deploy: `cd backend && pm2 restart crm-pilot-backend`; `cd frontend && npm run build && pm2 restart crm-pilot-frontend`.
- [ ] Commit any fixes.

---

## Self-review notes (coverage vs spec)
- Spec §3 migrations → Tasks 1–2. §4 backend services + endpoints → Tasks 3–12. §5 frontend → Tasks 13–18. §6 phasing preserved. §7 acceptance → Task 19.
- Provider = Gemini Flash via existing `analystReport.runTierA` (Task 8 extends it; Task 9's `diagnoseLead` mirrors `cron_analyst_tier_a_prewarm.js`). No OpenAI.
- Human-staff outbound = `cs_id IS NOT NULL` used in salesPromise (Task 3), panel enrichment (Task 6), FU times (Task 6).
- Open implementation detail for the executor: `diagnoseLead()` must reuse the transcript builder + `crm_lotus_state` upsert exactly as `cron_analyst_tier_a_prewarm.js` — read that file before Task 9.
