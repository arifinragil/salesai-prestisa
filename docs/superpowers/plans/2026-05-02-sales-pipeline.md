# Sales Pipeline & Conversion Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sales pipeline (deal stages) layered onto existing `crm_conversations`, with auto-transition rules from existing AI/order events, manual override via kanban drag-drop, forecast view, and backfill for existing data.

**Architecture:** Extend `crm_conversations` with pipeline columns (no new entity table). Single `pipelineEngine` service exposes pure stage-transition logic + DB writers. Hook calls inserted into existing event hot-paths (webhook ingest, aiAgent, aiTools, funnel, deliveryComms, handover resolve, claim, snooze, spam). Audit trail in new `crm_pipeline_events` table. Frontend kanban board at `/pipeline` + integration badges in inbox/chat/monitor/customer panel/tags.

**Tech Stack:** Node 20, Express 5, PostgreSQL (`pg`), MySQL (`mysql2`, read-only for `order` lookup), Jest 29 unit tests, Next.js 14 Pages Router + SWR + Tailwind v3 frontend.

**Reference patterns already in this repo:**
- `backend/services/aiConfidence.js` — pure function module pattern (mirror for `pipelineEngine.computeNextStage`)
- `backend/services/spamFilter.js` — service exposing `check(client, opts)` called from webhook (mirror for engine `apply`)
- `backend/scripts/dailyBrief.js` — cron script pattern with `pg.end()` cleanup
- `backend/scripts/pipelineBackfill.js` style: see `backend/scripts/customerHealthCompute.js` (batch upsert pattern)
- `backend/__tests__/aiConfidence.test.js` — Jest test pattern
- `frontend/src/pages/inbox/index.js` — list page with SWR + filters
- `frontend/src/components/MessageBubble.jsx` — small component file pattern

**Conventions:**
- CommonJS (`require`/`module.exports`) backend, ES modules frontend
- Commits use Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`)
- Commit after every passing task; never commit broken tests
- All file paths absolute under `/home/krttpt/crm/`
- Frontend: Tailwind utility classes; never CSS modules
- Frontend file size: prefer ≤200 lines per component, split when bigger

**TDD discipline:**
- Pure functions in `pipelineEngine`: red → green with Jest
- DB-writer functions: integration tested via real PG with `BEGIN`/`ROLLBACK` per test
- Hook integrations: smoke test via running backend + manual API call (no Jest, manual via `curl`/`psql`)
- Frontend: manual UAT (no automated browser test in this repo's existing setup)

---

## Task 1: Migration 013 — schema changes

**Files:**
- Create: `/home/krttpt/crm/backend/migrations/013_pipeline.sql`

- [ ] **Step 1.1: Write migration SQL**

Create `/home/krttpt/crm/backend/migrations/013_pipeline.sql`:

```sql
-- 013 — Sales pipeline foundations.

-- Extend crm_conversations
ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS pipeline_stage varchar(32) NOT NULL DEFAULT 'baru',
  ADD COLUMN IF NOT EXISTS pipeline_stage_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS pipeline_type varchar(16) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS deal_value_idr bigint,
  ADD COLUMN IF NOT EXISTS deal_value_locked boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deal_order_id integer,
  ADD COLUMN IF NOT EXISTS lost_reason varchar(32),
  ADD COLUMN IF NOT EXISTS lost_note text,
  ADD COLUMN IF NOT EXISTS manual_stage_override boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pipeline_stage_history jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS crm_conv_pipeline_stage_idx
  ON crm_conversations (pipeline_stage, pipeline_stage_at DESC);
CREATE INDEX IF NOT EXISTS crm_conv_pipeline_type_idx
  ON crm_conversations (pipeline_type)
  WHERE pipeline_stage NOT IN ('delivered','lost');
CREATE INDEX IF NOT EXISTS crm_conv_deal_order_idx
  ON crm_conversations (deal_order_id) WHERE deal_order_id IS NOT NULL;

-- Extend crm_tags with pipeline_type mapping
ALTER TABLE crm_tags
  ADD COLUMN IF NOT EXISTS maps_to_pipeline_type varchar(16);

-- Audit trail: pipeline events
CREATE TABLE IF NOT EXISTS crm_pipeline_events (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  from_stage      varchar(32),
  to_stage        varchar(32) NOT NULL,
  source          varchar(48) NOT NULL,
  staff_id        integer REFERENCES staff_users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_pipeline_events_conv_idx
  ON crm_pipeline_events (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS crm_pipeline_events_stage_idx
  ON crm_pipeline_events (to_stage, created_at DESC);
```

- [ ] **Step 1.2: Apply migration**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node db/migrate.js
```

Expected last lines:
```
[migrate] applying 013_pipeline.sql...
[migrate] applied 013_pipeline.sql
[migrate] done.
```

- [ ] **Step 1.3: Verify schema**

```bash
eval "$(grep -E '^PG_(HOST|PORT|DATABASE|USER|PASSWORD)=' /home/krttpt/crm/.env | sed 's/=\(.*\)$/=\"\1\"/')" && \
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" -tAc \
"SELECT column_name FROM information_schema.columns WHERE table_name='crm_conversations' AND column_name LIKE 'pipeline%' OR column_name LIKE 'deal%' OR column_name LIKE 'lost%' OR column_name LIKE 'manual_stage%' ORDER BY column_name"
```

Expected output (10 columns):
```
deal_order_id
deal_value_idr
deal_value_locked
lost_note
lost_reason
manual_stage_override
pipeline_stage
pipeline_stage_at
pipeline_stage_history
pipeline_type
```

- [ ] **Step 1.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/migrations/013_pipeline.sql && git commit -m "feat(pipeline): migration 013 — pipeline columns + events table"
```

---

## Task 2: pipelineConstants module

**Files:**
- Create: `/home/krttpt/crm/backend/services/pipelineConstants.js`

- [ ] **Step 2.1: Create constants module**

Create `/home/krttpt/crm/backend/services/pipelineConstants.js`:

```js
// Shared constants for pipeline. Imported by pipelineEngine, routes, scripts, tests.

const STAGES = ['baru', 'tertarik', 'form_dikirim', 'order_submitted', 'paid', 'delivered', 'lost'];

const STAGE_ORDER = {
  baru: 0,
  tertarik: 1,
  form_dikirim: 2,
  order_submitted: 3,
  paid: 4,
  delivered: 5,
  // lost is orthogonal — no order
};

const STAGE_PROBABILITY = {
  baru: 0.05,
  tertarik: 0.15,
  form_dikirim: 0.35,
  order_submitted: 0.70,
  paid: 0.95,
  delivered: 1.00,
  lost: 0.00,
};

const TYPES = ['papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b', 'unknown'];

const LOST_REASONS = [
  'no_reply',
  'harga_terlalu_tinggi',
  'kompetitor',
  'produk_tidak_cocok',
  'timing_tidak_pas',
  'cancelled',
  'refund_complaint',
  'other_with_note',
];

const TERMINAL_STAGES = new Set(['delivered', 'lost']);

function isStageForward(from, to) {
  if (to === 'lost') return false; // lost is orthogonal
  if (from === 'lost') return false; // recovery from lost handled separately
  const fromOrder = STAGE_ORDER[from];
  const toOrder = STAGE_ORDER[to];
  if (fromOrder == null || toOrder == null) return false;
  return toOrder > fromOrder;
}

module.exports = {
  STAGES, STAGE_ORDER, STAGE_PROBABILITY, TYPES, LOST_REASONS, TERMINAL_STAGES, isStageForward,
};
```

- [ ] **Step 2.2: Quick smoke (no test file yet)**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node -e "const c=require('./services/pipelineConstants'); console.log('forward baru→tertarik:', c.isStageForward('baru','tertarik')); console.log('forward tertarik→baru:', c.isStageForward('tertarik','baru')); console.log('lost forward?:', c.isStageForward('baru','lost'));"
```

Expected:
```
forward baru→tertarik: true
forward tertarik→baru: false
lost forward?: false
```

- [ ] **Step 2.3: Commit**

```bash
cd /home/krttpt/crm && git add backend/services/pipelineConstants.js && git commit -m "feat(pipeline): shared constants module (stages, probabilities, types, lost reasons)"
```

---

## Task 3: pipelineEngine.computeNextStage (pure function) + tests

**Files:**
- Create: `/home/krttpt/crm/backend/services/pipelineEngine.js`
- Create: `/home/krttpt/crm/backend/__tests__/pipelineEngine.test.js`

- [ ] **Step 3.1: Write failing test for computeNextStage**

Create `/home/krttpt/crm/backend/__tests__/pipelineEngine.test.js`:

```js
const { computeNextStage } = require('../services/pipelineEngine');

describe('computeNextStage', () => {
  // Forward auto-transitions
  test('baru + intent_qualified → tertarik', () => {
    expect(computeNextStage('baru', { type: 'intent_qualified' }, false)).toBe('tertarik');
  });

  test('tertarik + order_url_sent → form_dikirim', () => {
    expect(computeNextStage('tertarik', { type: 'order_url_sent' }, false)).toBe('form_dikirim');
  });

  test('baru + order_url_sent → form_dikirim (skip stage)', () => {
    expect(computeNextStage('baru', { type: 'order_url_sent' }, false)).toBe('form_dikirim');
  });

  test('form_dikirim + order_submitted → order_submitted', () => {
    expect(computeNextStage('form_dikirim', { type: 'order_submitted' }, false)).toBe('order_submitted');
  });

  test('order_submitted + order_paid → paid', () => {
    expect(computeNextStage('order_submitted', { type: 'order_paid' }, false)).toBe('paid');
  });

  test('paid + order_delivered → delivered', () => {
    expect(computeNextStage('paid', { type: 'order_delivered' }, false)).toBe('delivered');
  });

  // Lost transitions
  test('any stage + handover_refund → lost', () => {
    expect(computeNextStage('tertarik', { type: 'handover_refund' }, false)).toBe('lost');
    expect(computeNextStage('paid', { type: 'handover_refund' }, false)).toBe('lost');
  });

  test('any stage + handover_cancel → lost', () => {
    expect(computeNextStage('form_dikirim', { type: 'handover_cancel' }, false)).toBe('lost');
  });

  test('any stage + spam_blocked → lost', () => {
    expect(computeNextStage('baru', { type: 'spam_blocked' }, false)).toBe('lost');
  });

  test('tertarik/form_dikirim + stale_no_reply → lost', () => {
    expect(computeNextStage('tertarik', { type: 'stale_no_reply' }, false)).toBe('lost');
    expect(computeNextStage('form_dikirim', { type: 'stale_no_reply' }, false)).toBe('lost');
  });

  // Override semantics
  test('manual override blocks backward auto-transition', () => {
    // current=tertarik (operator manually set), event would compute baru → no-op
    expect(computeNextStage('tertarik', { type: 'intent_qualified' }, true)).toBeNull();
  });

  test('manual override does NOT block forward auto-transition', () => {
    // operator set tertarik, then form sent → still moves forward
    expect(computeNextStage('tertarik', { type: 'order_url_sent' }, true)).toBe('form_dikirim');
  });

  test('manual override does not block lost transition', () => {
    expect(computeNextStage('tertarik', { type: 'handover_refund' }, true)).toBe('lost');
  });

  // Idempotency: same-stage event returns null (no-op)
  test('same stage event returns null', () => {
    expect(computeNextStage('tertarik', { type: 'intent_qualified' }, false)).toBeNull();
  });

  test('order_paid on stage already paid returns null', () => {
    expect(computeNextStage('paid', { type: 'order_paid' }, false)).toBeNull();
  });

  // Reactivation
  test('lost + customer_replied → tertarik (reactivate)', () => {
    expect(computeNextStage('lost', { type: 'customer_replied' }, false)).toBe('tertarik');
  });

  test('delivered + customer_replied → null (do NOT reactivate)', () => {
    expect(computeNextStage('delivered', { type: 'customer_replied' }, false)).toBeNull();
  });

  // Operator claim
  test('baru + operator_claim → tertarik', () => {
    expect(computeNextStage('baru', { type: 'operator_claim' }, false)).toBe('tertarik');
  });

  test('form_dikirim + operator_claim → null (no change)', () => {
    expect(computeNextStage('form_dikirim', { type: 'operator_claim' }, false)).toBeNull();
  });

  // Stale baru (different threshold)
  test('baru + stale_baru_no_reply → lost', () => {
    expect(computeNextStage('baru', { type: 'stale_baru_no_reply' }, false)).toBe('lost');
  });

  // Unknown event → null (defensive)
  test('unknown event → null', () => {
    expect(computeNextStage('baru', { type: 'unknown_xyz' }, false)).toBeNull();
  });
});
```

- [ ] **Step 3.2: Run test to verify failure**

```bash
cd /home/krttpt/crm/backend && npx jest pipelineEngine -t computeNextStage 2>&1 | tail -10
```

Expected: FAIL with "Cannot find module '../services/pipelineEngine'".

- [ ] **Step 3.3: Implement computeNextStage**

Create `/home/krttpt/crm/backend/services/pipelineEngine.js`:

```js
// Sales pipeline engine. Pure stage-transition logic + DB writers.
const pg = require('../db/postgres');
const logger = require('./logger');
const { STAGE_PROBABILITY, TERMINAL_STAGES, isStageForward } = require('./pipelineConstants');

// Event → resulting stage (without override consideration).
// Returns null if the event has no defined transition for the current stage.
function rawTransition(currentStage, event) {
  const t = event.type;

  // Lost transitions — orthogonal, win against current stage
  if (t === 'handover_refund' || t === 'handover_cancel' || t === 'spam_blocked') {
    return currentStage === 'lost' ? null : 'lost';
  }
  if (t === 'stale_no_reply') {
    if (currentStage === 'tertarik' || currentStage === 'form_dikirim') return 'lost';
    return null;
  }
  if (t === 'stale_baru_no_reply') {
    if (currentStage === 'baru') return 'lost';
    return null;
  }

  // Reactivation: only from lost (delivered intentionally excluded)
  if (t === 'customer_replied') {
    if (currentStage === 'lost') return 'tertarik';
    return null;
  }

  // Forward auto-transitions
  if (t === 'intent_qualified') {
    if (currentStage === 'baru') return 'tertarik';
    return null;
  }
  if (t === 'operator_claim') {
    if (currentStage === 'baru') return 'tertarik';
    return null;
  }
  if (t === 'order_url_sent') {
    // Allow skipping baru → form_dikirim
    if (currentStage === 'baru' || currentStage === 'tertarik') return 'form_dikirim';
    return null;
  }
  if (t === 'order_submitted') {
    if (currentStage === 'form_dikirim' || currentStage === 'tertarik' || currentStage === 'baru') {
      return 'order_submitted';
    }
    return null;
  }
  if (t === 'order_paid') {
    if (currentStage === 'order_submitted') return 'paid';
    return null;
  }
  if (t === 'order_delivered') {
    if (currentStage === 'paid') return 'delivered';
    return null;
  }

  return null;
}

// Compute target stage applying override semantics.
// Returns null if no transition (no-op).
function computeNextStage(currentStage, event, manualOverride) {
  const target = rawTransition(currentStage, event);
  if (target == null) return null;
  if (target === currentStage) return null; // idempotent

  // Lost always wins (manual or not)
  if (target === 'lost') return target;

  // Reactivation always wins
  if (currentStage === 'lost') return target;

  // Manual override only blocks non-forward auto-transitions
  if (manualOverride && !isStageForward(currentStage, target)) {
    return null;
  }

  return target;
}

module.exports = {
  computeNextStage,
  rawTransition,
  STAGE_PROBABILITY,
  TERMINAL_STAGES,
};
```

- [ ] **Step 3.4: Run test to verify pass**

```bash
cd /home/krttpt/crm/backend && npx jest pipelineEngine -t computeNextStage 2>&1 | tail -10
```

Expected: all tests pass (15+ test cases).

- [ ] **Step 3.5: Commit**

```bash
cd /home/krttpt/crm && git add backend/services/pipelineEngine.js backend/__tests__/pipelineEngine.test.js && git commit -m "feat(pipeline): pure computeNextStage + tests"
```

---

## Task 4: pipelineEngine.apply (DB writer) + integration tests

**Files:**
- Modify: `/home/krttpt/crm/backend/services/pipelineEngine.js`
- Modify: `/home/krttpt/crm/backend/__tests__/pipelineEngine.test.js`

- [ ] **Step 4.1: Add integration test for apply**

Append to `/home/krttpt/crm/backend/__tests__/pipelineEngine.test.js`:

```js
const pg = require('../db/postgres');
const { apply } = require('../services/pipelineEngine');

describe('apply (DB writer)', () => {
  let convId;

  beforeAll(async () => {
    // Create a temp test conv
    const r = await pg.query(
      `INSERT INTO crm_conversations (phone, status) VALUES ('628999000001', 'open') RETURNING id`
    );
    convId = r.rows[0].id;
  });

  afterAll(async () => {
    await pg.query(`DELETE FROM crm_pipeline_events WHERE conversation_id = $1`, [convId]);
    await pg.query(`DELETE FROM crm_conversations WHERE id = $1`, [convId]);
    await pg.end();
  });

  test('apply intent_qualified on baru → tertarik', async () => {
    // Reset to baru
    await pg.query(
      `UPDATE crm_conversations SET pipeline_stage='baru', manual_stage_override=FALSE, pipeline_stage_history='[]'::jsonb WHERE id=$1`,
      [convId]
    );
    const r = await apply(pg, convId, { type: 'intent_qualified' }, { source: 'auto:test' });
    expect(r.applied).toBe(true);
    expect(r.fromStage).toBe('baru');
    expect(r.toStage).toBe('tertarik');

    const c = await pg.query(`SELECT pipeline_stage, manual_stage_override, pipeline_stage_history FROM crm_conversations WHERE id=$1`, [convId]);
    expect(c.rows[0].pipeline_stage).toBe('tertarik');
    expect(c.rows[0].manual_stage_override).toBe(false);
    expect(c.rows[0].pipeline_stage_history).toHaveLength(1);
    expect(c.rows[0].pipeline_stage_history[0].source).toBe('auto:test');
  });

  test('apply same event twice is idempotent (no event row dup)', async () => {
    const before = await pg.query(`SELECT COUNT(*)::int AS n FROM crm_pipeline_events WHERE conversation_id=$1`, [convId]);
    const r = await apply(pg, convId, { type: 'intent_qualified' }, { source: 'auto:test' });
    expect(r.applied).toBe(false);
    const after = await pg.query(`SELECT COUNT(*)::int AS n FROM crm_pipeline_events WHERE conversation_id=$1`, [convId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('apply with manual=true sets override flag and forces transition', async () => {
    const r = await apply(pg, convId, { type: 'manual_set', targetStage: 'paid' }, { source: 'manual:operator', staffId: null, force: true });
    expect(r.applied).toBe(true);
    expect(r.toStage).toBe('paid');
    const c = await pg.query(`SELECT pipeline_stage, manual_stage_override FROM crm_conversations WHERE id=$1`, [convId]);
    expect(c.rows[0].pipeline_stage).toBe('paid');
    expect(c.rows[0].manual_stage_override).toBe(true);
  });

  test('manual override blocks backward auto-event but allows forward', async () => {
    // currently paid + override true. order_submitted event would be backward → no-op
    const r1 = await apply(pg, convId, { type: 'order_submitted' }, { source: 'auto:funnel' });
    expect(r1.applied).toBe(false);
    // order_delivered event from paid → forward → allowed, override should reset
    const r2 = await apply(pg, convId, { type: 'order_delivered' }, { source: 'auto:cron' });
    expect(r2.applied).toBe(true);
    expect(r2.toStage).toBe('delivered');
    const c = await pg.query(`SELECT manual_stage_override FROM crm_conversations WHERE id=$1`, [convId]);
    expect(c.rows[0].manual_stage_override).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run test, expect failure**

```bash
cd /home/krttpt/crm/backend && npx jest pipelineEngine -t "apply" 2>&1 | tail -15
```

Expected: FAIL — `apply is not a function`.

- [ ] **Step 4.3: Implement apply + helpers**

Append to `/home/krttpt/crm/backend/services/pipelineEngine.js` (before `module.exports`):

```js
// Apply an event to a conversation. Persists transition + audit + history.
// Returns { applied, fromStage, toStage, reason }.
//
// options:
//   source       — string label for audit (e.g. 'auto:intent_classifier', 'manual:operator')
//   staffId      — optional staff_users.id for audit
//   force        — when true (manual operator action), use targetStage from event directly
//   metadata     — JSON to store on crm_pipeline_events.metadata
//   lostReason   — populated when toStage='lost'
//   lostNote     — free-text note for lost
async function apply(client, convId, event, options = {}) {
  const { rows } = await client.query(
    `SELECT pipeline_stage, manual_stage_override FROM crm_conversations WHERE id = $1`,
    [convId]
  );
  if (!rows[0]) {
    return { applied: false, reason: 'conv_not_found' };
  }
  const fromStage = rows[0].pipeline_stage;
  const overrideFlag = rows[0].manual_stage_override;

  let toStage;
  if (options.force && event.targetStage) {
    toStage = event.targetStage;
  } else {
    toStage = computeNextStage(fromStage, event, overrideFlag);
  }

  if (toStage == null || toStage === fromStage) {
    return { applied: false, fromStage, toStage: fromStage, reason: 'no_transition' };
  }

  // Decide whether to set/clear override flag
  let nextOverride = overrideFlag;
  if (options.force) {
    nextOverride = true;
  } else if (overrideFlag && isStageForward(fromStage, toStage)) {
    // Auto-event pushed forward → reset override
    nextOverride = false;
  }

  const histEntry = {
    stage: toStage,
    at: new Date().toISOString(),
    by: options.staffId || null,
    source: options.source || 'unknown',
  };

  const setLost = toStage === 'lost';
  await client.query(
    `UPDATE crm_conversations
       SET pipeline_stage = $2,
           pipeline_stage_at = now(),
           manual_stage_override = $3,
           pipeline_stage_history = pipeline_stage_history || $4::jsonb,
           lost_reason = CASE WHEN $5 THEN $6 ELSE NULL END,
           lost_note   = CASE WHEN $5 THEN $7 ELSE NULL END,
           updated_at = now()
     WHERE id = $1`,
    [convId, toStage, nextOverride, JSON.stringify(histEntry),
     setLost, options.lostReason || null, options.lostNote || null]
  );

  await client.query(
    `INSERT INTO crm_pipeline_events
       (conversation_id, from_stage, to_stage, source, staff_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [convId, fromStage, toStage, options.source || 'unknown',
     options.staffId || null, JSON.stringify(options.metadata || {})]
  );

  logger.info({ convId, fromStage, toStage, source: options.source }, '[pipeline] transition');
  return { applied: true, fromStage, toStage, reason: 'transition_applied' };
}

// Set pipeline_type without changing stage. Idempotent unless force=true.
async function setType(client, convId, type, options = {}) {
  if (!options.force) {
    const r = await client.query(`SELECT pipeline_type FROM crm_conversations WHERE id = $1`, [convId]);
    if (r.rows[0]?.pipeline_type && r.rows[0].pipeline_type !== 'unknown') {
      return { applied: false, reason: 'type_already_set' };
    }
  }
  await client.query(
    `UPDATE crm_conversations SET pipeline_type = $2, updated_at = now() WHERE id = $1`,
    [convId, type]
  );
  return { applied: true };
}

// Set deal value (manual operator input for high-value segment).
async function setDealValue(client, convId, valueIdr, lock = false) {
  await client.query(
    `UPDATE crm_conversations
       SET deal_value_idr = $2, deal_value_locked = $3, updated_at = now()
     WHERE id = $1`,
    [convId, valueIdr, !!lock]
  );
}

// Auto-fill deal_value_idr + deal_order_id from MySQL order (when respect-lock is true,
// skip if locked).
async function fillFromOrder(client, convId, orderId, valueIdr) {
  const r = await client.query(`SELECT deal_value_locked FROM crm_conversations WHERE id = $1`, [convId]);
  if (r.rows[0]?.deal_value_locked) {
    // Update order_id only, keep value
    await client.query(
      `UPDATE crm_conversations SET deal_order_id = $2 WHERE id = $1`,
      [convId, orderId]
    );
    return;
  }
  await client.query(
    `UPDATE crm_conversations SET deal_order_id = $2, deal_value_idr = $3 WHERE id = $1`,
    [convId, orderId, valueIdr]
  );
}
```

Update `module.exports` to include new functions:

```js
module.exports = {
  computeNextStage,
  rawTransition,
  apply,
  setType,
  setDealValue,
  fillFromOrder,
  STAGE_PROBABILITY,
  TERMINAL_STAGES,
};
```

- [ ] **Step 4.4: Run integration tests**

```bash
cd /home/krttpt/crm/backend && npx jest pipelineEngine 2>&1 | tail -15
```

Expected: all tests pass (compute + apply suites).

- [ ] **Step 4.5: Commit**

```bash
cd /home/krttpt/crm && git add backend/services/pipelineEngine.js backend/__tests__/pipelineEngine.test.js && git commit -m "feat(pipeline): apply/setType/setDealValue DB writers + integration tests"
```

---

## Task 5: pipelineEngine.computeForecast + computeConversionRates

**Files:**
- Modify: `/home/krttpt/crm/backend/services/pipelineEngine.js`
- Modify: `/home/krttpt/crm/backend/__tests__/pipelineEngine.test.js`

- [ ] **Step 5.1: Append forecast tests**

Append to `/home/krttpt/crm/backend/__tests__/pipelineEngine.test.js`:

```js
const { computeForecastFromRows } = require('../services/pipelineEngine');

describe('computeForecastFromRows', () => {
  test('sums value × probability for non-terminal stages with value', () => {
    const rows = [
      { pipeline_stage: 'tertarik', deal_value_idr: 500_000 },        // 0.15 × 500k = 75k
      { pipeline_stage: 'form_dikirim', deal_value_idr: 1_000_000 },  // 0.35 × 1M = 350k
      { pipeline_stage: 'order_submitted', deal_value_idr: 2_000_000 }, // 0.70 × 2M = 1.4M
      { pipeline_stage: 'paid', deal_value_idr: 750_000 },             // 0.95 × 750k = 712.5k
      { pipeline_stage: 'delivered', deal_value_idr: 800_000 },        // excluded (terminal)
      { pipeline_stage: 'lost', deal_value_idr: 600_000 },             // excluded (probability 0)
      { pipeline_stage: 'baru', deal_value_idr: null },                // excluded (no value)
    ];
    const r = computeForecastFromRows(rows);
    // 75k + 350k + 1.4M + 712.5k = 2,537,500
    expect(r.expectedRevenue).toBe(2_537_500);
    // realized = paid + delivered with value (paid 750k + delivered 800k = 1,550,000)
    // (Note: realized does NOT exclude paid since paid is "essentially won")
    expect(r.realizedRevenue).toBe(1_550_000);
    expect(r.dealCount).toBe(7);
  });

  test('byStage groups count + sum', () => {
    const rows = [
      { pipeline_stage: 'tertarik', deal_value_idr: 100_000 },
      { pipeline_stage: 'tertarik', deal_value_idr: 200_000 },
      { pipeline_stage: 'paid', deal_value_idr: 500_000 },
    ];
    const r = computeForecastFromRows(rows);
    expect(r.byStage.tertarik).toEqual({ count: 2, value: 300_000 });
    expect(r.byStage.paid).toEqual({ count: 1, value: 500_000 });
  });

  test('handles empty rows', () => {
    const r = computeForecastFromRows([]);
    expect(r.expectedRevenue).toBe(0);
    expect(r.dealCount).toBe(0);
  });
});
```

- [ ] **Step 5.2: Run, expect failure**

```bash
cd /home/krttpt/crm/backend && npx jest pipelineEngine -t computeForecastFromRows 2>&1 | tail -10
```

Expected: FAIL — function not exported.

- [ ] **Step 5.3: Implement forecast functions**

Append to `/home/krttpt/crm/backend/services/pipelineEngine.js` (before `module.exports`):

```js
// Pure: compute forecast totals from an array of conv rows.
// Inputs: rows with { pipeline_stage, deal_value_idr }.
function computeForecastFromRows(rows) {
  let expectedRevenue = 0;
  let realizedRevenue = 0;
  const byStage = {};
  for (const r of rows) {
    const stage = r.pipeline_stage;
    const v = Number(r.deal_value_idr) || 0;
    byStage[stage] ||= { count: 0, value: 0 };
    byStage[stage].count += 1;
    byStage[stage].value += v;

    if (v <= 0) continue;
    if (stage === 'delivered' || stage === 'paid') {
      realizedRevenue += v;
    } else if (!TERMINAL_STAGES.has(stage)) {
      expectedRevenue += v * (STAGE_PROBABILITY[stage] || 0);
    }
  }
  return {
    expectedRevenue: Math.round(expectedRevenue),
    realizedRevenue: Math.round(realizedRevenue),
    dealCount: rows.length,
    byStage,
  };
}

// DB-backed: filter active deals & call pure forecast.
async function computeForecast(filters = {}) {
  const where = ['1=1'];
  const params = [];
  if (filters.type) { params.push(filters.type); where.push(`pipeline_type = $${params.length}`); }
  if (filters.dateFrom) { params.push(filters.dateFrom); where.push(`pipeline_stage_at >= $${params.length}`); }
  const sql = `SELECT pipeline_stage, deal_value_idr FROM crm_conversations WHERE ${where.join(' AND ')}`;
  const { rows } = await pg.query(sql, params);
  return computeForecastFromRows(rows);
}

// Conversion rate from event log: count of deals that reached stage A in window / count that reached stage B.
async function computeConversionRates(days = 30) {
  const { rows } = await pg.query(
    `SELECT to_stage, COUNT(DISTINCT conversation_id)::int AS n
     FROM crm_pipeline_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY to_stage`,
    [String(days)]
  );
  const counts = {};
  for (const r of rows) counts[r.to_stage] = r.n;
  const stageOrder = ['baru', 'tertarik', 'form_dikirim', 'order_submitted', 'paid', 'delivered'];
  const rates = {};
  for (let i = 1; i < stageOrder.length; i++) {
    const from = stageOrder[i - 1];
    const to = stageOrder[i];
    const fromN = counts[from] || 0;
    const toN = counts[to] || 0;
    rates[`${from}→${to}`] = fromN ? +(toN / fromN).toFixed(3) : 0;
  }
  return { rates, counts };
}

// Avg seconds spent per stage (for non-terminal stages currently in pipeline).
async function computeAvgTimePerStage() {
  const { rows } = await pg.query(
    `SELECT pipeline_stage,
            AVG(EXTRACT(EPOCH FROM (now() - pipeline_stage_at)))::int AS avg_seconds
     FROM crm_conversations
     WHERE pipeline_stage NOT IN ('delivered','lost')
     GROUP BY pipeline_stage`
  );
  const out = {};
  for (const r of rows) out[r.pipeline_stage] = Number(r.avg_seconds) || 0;
  return out;
}

async function topLostReasons(days = 30, limit = 5) {
  const { rows } = await pg.query(
    `SELECT lost_reason, COUNT(*)::int AS n FROM crm_conversations
     WHERE pipeline_stage='lost' AND pipeline_stage_at > now() - ($1 || ' days')::interval
       AND lost_reason IS NOT NULL
     GROUP BY lost_reason ORDER BY n DESC LIMIT $2`,
    [String(days), limit]
  );
  return rows;
}
```

Update `module.exports`:

```js
module.exports = {
  computeNextStage,
  rawTransition,
  apply,
  setType,
  setDealValue,
  fillFromOrder,
  computeForecastFromRows,
  computeForecast,
  computeConversionRates,
  computeAvgTimePerStage,
  topLostReasons,
  STAGE_PROBABILITY,
  TERMINAL_STAGES,
};
```

- [ ] **Step 5.4: Run all pipelineEngine tests**

```bash
cd /home/krttpt/crm/backend && npx jest pipelineEngine 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 5.5: Commit**

```bash
cd /home/krttpt/crm && git add backend/services/pipelineEngine.js backend/__tests__/pipelineEngine.test.js && git commit -m "feat(pipeline): forecast + conversion rate + avg time computations"
```

---

## Task 6: routes/pipeline.js — 7 API endpoints

**Files:**
- Create: `/home/krttpt/crm/backend/routes/pipeline.js`
- Modify: `/home/krttpt/crm/backend/index.js`

- [ ] **Step 6.1: Create routes file**

Create `/home/krttpt/crm/backend/routes/pipeline.js`:

```js
// Pipeline API — operator-facing CRUD + analytics.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const engine = require('../services/pipelineEngine');
const { STAGES, TYPES, LOST_REASONS } = require('../services/pipelineConstants');
const notify = require('../services/notify');

const router = express.Router();
router.use(requireStaff);

// GET /api/pipeline/board — list grouped by stage
router.get('/board', async (req, res) => {
  const where = ['1=1'];
  const params = [];
  if (req.query.type) { params.push(req.query.type); where.push(`c.pipeline_type = $${params.length}`); }
  if (req.query.claimed_by === 'me') {
    params.push(req.staff.staff_id);
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_claims cl WHERE cl.conversation_id=c.id AND cl.released_at IS NULL AND cl.expires_at > now() AND cl.staff_id = $${params.length})`);
  } else if (req.query.claimed_by) {
    params.push(parseInt(req.query.claimed_by));
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_claims cl WHERE cl.conversation_id=c.id AND cl.released_at IS NULL AND cl.expires_at > now() AND cl.staff_id = $${params.length})`);
  }
  if (req.query.tag_id) {
    params.push(parseInt(req.query.tag_id));
    where.push(`EXISTS (SELECT 1 FROM crm_conversation_tags ct WHERE ct.conversation_id=c.id AND ct.tag_id = $${params.length})`);
  }
  if (req.query.date_from) { params.push(req.query.date_from); where.push(`c.last_message_at >= $${params.length}`); }

  const { rows } = await pg.query(
    `SELECT c.id, c.phone, c.real_phone, c.push_name, c.pipeline_stage, c.pipeline_type,
            c.deal_value_idr, c.deal_value_locked, c.manual_stage_override,
            c.last_message_at, c.lost_reason,
            (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color))
             FROM crm_tags t JOIN crm_conversation_tags ct ON ct.tag_id=t.id
             WHERE ct.conversation_id=c.id) AS tags,
            h.score AS health_score, h.band AS health_band
     FROM crm_conversations c
     LEFT JOIN crm_customer_health h ON h.customer_id = c.customer_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.pipeline_stage_at DESC LIMIT 1000`, params
  );
  const stages = {};
  for (const s of STAGES) stages[s] = [];
  for (const r of rows) (stages[r.pipeline_stage] || stages.baru).push(r);
  res.json({ success: true, stages });
});

// POST /api/pipeline/conversations/:id/stage — manual stage change
router.post('/conversations/:id/stage', async (req, res) => {
  const id = parseInt(req.params.id);
  const { stage, lost_reason, lost_note } = req.body || {};
  if (!STAGES.includes(stage)) return res.status(400).json({ success: false, message: `stage must be one of ${STAGES.join('|')}` });
  if (stage === 'lost' && !LOST_REASONS.includes(lost_reason)) {
    return res.status(400).json({ success: false, message: `lost_reason required: ${LOST_REASONS.join('|')}` });
  }
  if (stage === 'lost' && lost_reason === 'other_with_note' && !lost_note) {
    return res.status(400).json({ success: false, message: 'lost_note required when reason=other_with_note' });
  }
  const r = await engine.apply(pg, id, { type: 'manual_set', targetStage: stage }, {
    source: 'manual:operator', force: true, staffId: req.staff.staff_id,
    lostReason: lost_reason, lostNote: lost_note,
  });
  notify.notifyConvUpdated?.(id);
  res.json({ success: true, ...r });
});

// POST /api/pipeline/conversations/:id/type — manual type change
router.post('/conversations/:id/type', async (req, res) => {
  const id = parseInt(req.params.id);
  const { type } = req.body || {};
  if (!TYPES.includes(type)) return res.status(400).json({ success: false, message: `type must be one of ${TYPES.join('|')}` });
  await engine.setType(pg, id, type, { force: true });
  res.json({ success: true });
});

// POST /api/pipeline/conversations/:id/value — manual deal value (wedding/b2b)
router.post('/conversations/:id/value', async (req, res) => {
  const id = parseInt(req.params.id);
  const value = parseInt(req.body?.value_idr);
  const lock = !!req.body?.lock;
  if (!Number.isFinite(value) || value < 0) {
    return res.status(400).json({ success: false, message: 'value_idr must be non-negative integer' });
  }
  // Sanity: only allow for wedding/b2b
  const r = await pg.query(`SELECT pipeline_type FROM crm_conversations WHERE id=$1`, [id]);
  const t = r.rows[0]?.pipeline_type;
  if (!['wedding', 'b2b'].includes(t)) {
    return res.status(400).json({ success: false, message: 'manual deal value only allowed for wedding/b2b type (current: ' + t + ')' });
  }
  await engine.setDealValue(pg, id, value, lock);
  res.json({ success: true });
});

// POST /api/pipeline/conversations/:id/revert-stage — revert to previous stage in history
router.post('/conversations/:id/revert-stage', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT pipeline_stage, pipeline_stage_history FROM crm_conversations WHERE id=$1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  const hist = rows[0].pipeline_stage_history || [];
  // Find last entry that differs from current
  const previous = [...hist].reverse().find((e) => e.stage !== rows[0].pipeline_stage);
  if (!previous) return res.status(400).json({ success: false, message: 'no previous stage to revert to' });
  const r = await engine.apply(pg, id, { type: 'manual_set', targetStage: previous.stage }, {
    source: 'manual:revert', force: true, staffId: req.staff.staff_id,
    metadata: { revert_from: rows[0].pipeline_stage },
  });
  notify.notifyConvUpdated?.(id);
  res.json({ success: true, ...r });
});

// GET /api/pipeline/forecast
router.get('/forecast', async (req, res) => {
  const filters = {};
  if (req.query.type) filters.type = req.query.type;
  const [forecast, conv, avgTime, topLost] = await Promise.all([
    engine.computeForecast(filters),
    engine.computeConversionRates(parseInt(req.query.days) || 30),
    engine.computeAvgTimePerStage(),
    engine.topLostReasons(parseInt(req.query.days) || 30, 5),
  ]);
  // realized 30d (delivered only): separate query
  const realized = await pg.query(
    `SELECT COALESCE(SUM(deal_value_idr), 0)::bigint AS total
     FROM crm_conversations
     WHERE pipeline_stage='delivered' AND pipeline_stage_at > now() - interval '30 days'`
  );
  res.json({
    success: true,
    expected_revenue: forecast.expectedRevenue,
    realized_revenue_30d: Number(realized.rows[0].total),
    deal_count: forecast.dealCount,
    by_stage: forecast.byStage,
    conversion_rates: conv.rates,
    avg_time_per_stage_seconds: avgTime,
    top_lost_reasons: topLost,
  });
});

// GET /api/pipeline/events?conversation_id=X
router.get('/events', async (req, res) => {
  const convId = parseInt(req.query.conversation_id);
  if (!convId) return res.status(400).json({ success: false, message: 'conversation_id required' });
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { rows } = await pg.query(
    `SELECT e.id, e.from_stage, e.to_stage, e.source, e.staff_id, e.metadata, e.created_at,
            u.full_name AS staff_name
     FROM crm_pipeline_events e
     LEFT JOIN staff_users u ON u.id = e.staff_id
     WHERE e.conversation_id = $1
     ORDER BY e.id DESC LIMIT $2`,
    [convId, limit]
  );
  res.json({ success: true, items: rows });
});

module.exports = router;
```

- [ ] **Step 6.2: Register route in `index.js`**

Edit `/home/krttpt/crm/backend/index.js`. Add after `usersRoutes` line:

Find:
```js
const usersRoutes = require('./routes/users');
const funnelRoutes = require('./routes/funnel');
```

Replace with:
```js
const usersRoutes = require('./routes/users');
const funnelRoutes = require('./routes/funnel');
const pipelineRoutes = require('./routes/pipeline');
```

Find:
```js
app.use('/api/users', usersRoutes);
app.use('/api/funnel', funnelRoutes);
```

Replace with:
```js
app.use('/api/users', usersRoutes);
app.use('/api/funnel', funnelRoutes);
app.use('/api/pipeline', pipelineRoutes);
```

- [ ] **Step 6.3: Restart backend & smoke test**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online
sleep 2
curl -s -o /dev/null -w "GET /board (no auth) HTTP %{http_code}\n" http://localhost:3009/api/pipeline/board
```

Expected: `HTTP 401` (auth required, not 404).

- [ ] **Step 6.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/pipeline.js backend/index.js && git commit -m "feat(pipeline): 7 API endpoints (board, stage, type, value, revert, forecast, events)"
```

---

## Task 7: Hook — webhook ingest sets initial stage

**Files:**
- Modify: `/home/krttpt/crm/backend/routes/webhook.js`

The migration default already sets stage='baru' for new convs. We just need to insert a `crm_pipeline_events` row at conv-creation so the audit trail starts from a known event (otherwise the conv has stage but no event row, breaking conversion rate math).

- [ ] **Step 7.1: Find conv-creation in webhook.js**

```bash
grep -n "INSERT INTO crm_conversations" /home/krttpt/crm/backend/routes/webhook.js | head -3
```

Note the line number (likely around line 50-70). Read the surrounding code.

```bash
sed -n '40,90p' /home/krttpt/crm/backend/routes/webhook.js
```

Identify the block where a NEW conv was just created (vs found existing). Look for a `client.query('INSERT INTO crm_conversations ...')` followed by `RETURNING id`. The returned row tells us "new conv created here".

- [ ] **Step 7.2: Insert hook**

After the conv INSERT block, add (use exact context discovered in step 7.1):

```js
// Pipeline: bootstrap event for new conv
if (convCreatedThisRequest) { // adjust variable name to match local
  await client.query(
    `INSERT INTO crm_pipeline_events (conversation_id, from_stage, to_stage, source)
     VALUES ($1, NULL, 'baru', 'auto:conv_created')`,
    [conv.id]
  );
}
```

If the existing code uses a different flag/structure to distinguish new vs existing conv, adapt accordingly. If no flag, query `xmax = 0` from the INSERT (returns 0 for new row, non-zero for upsert) — but most likely the INSERT is wrapped in an `IF NOT EXISTS` or the code already branches. Read carefully.

- [ ] **Step 7.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
# Check no errors at startup
pm2 logs crm-pilot-backend --lines 5 --nostream 2>&1 | tail -5
```

Expected: backend listening, no errors.

- [ ] **Step 7.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/webhook.js && git commit -m "feat(pipeline): bootstrap event on conv create"
```

---

## Task 8: Hook — aiAgent intent classify → tertarik

**Files:**
- Modify: `/home/krttpt/crm/backend/services/aiAgent.js`

- [ ] **Step 8.1: Locate intent classify call**

```bash
grep -n "gemini.classifyIntent\|cls = await gemini" /home/krttpt/crm/backend/services/aiAgent.js | head -3
```

- [ ] **Step 8.2: Add hook call after classify result**

After the line `const cls = await gemini.classifyIntent(inboundText);`, **and after** any existing `[aiAgent] pre-classified` logger call, before the dangerous-intent branching, insert:

```js
    // Pipeline: intent_qualified event
    try {
      const QUALIFY = new Set(['order_intent', 'pricing', 'shipping', 'payment']);
      if (cls.confidence >= 0.6 && QUALIFY.has(cls.intent)) {
        const engine = require('./pipelineEngine');
        await engine.apply(client, conv.id, { type: 'intent_qualified' }, {
          source: 'auto:intent_classifier',
          metadata: { intent: cls.intent, confidence: cls.confidence },
        });
      }
    } catch (err) {
      logger.warn({ err: err.message, conv_id: conv.id }, '[pipeline] intent hook failed');
    }
```

Also add hook for handover events. Find each `recordHandover` call site that has `reason: 'refund'` or `reason: 'cancel'` (look for handover banner banner usage — actually handover with these reasons is set via `routes/inbox.js` resolve, not from aiAgent). Skip in this task; covered by Task 12.

- [ ] **Step 8.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
pm2 logs crm-pilot-backend --lines 5 --nostream 2>&1 | tail -5
```

- [ ] **Step 8.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/services/aiAgent.js && git commit -m "feat(pipeline): hook intent_qualified event into aiAgent classify"
```

---

## Task 9: Hook — aiTools build_order_form_url → form_dikirim

**Files:**
- Modify: `/home/krttpt/crm/backend/services/aiTools.js`

- [ ] **Step 9.1: Locate build_order_form_url function**

```bash
grep -n "async function build_order_form_url\|setType\|UPDATE crm_conversations" /home/krttpt/crm/backend/services/aiTools.js | head -10
```

- [ ] **Step 9.2: Add pipeline hook + type set**

In `build_order_form_url`, after the existing `UPDATE crm_conversations SET last_order_url_sent_at = now()...` statement, add:

```js
      // Pipeline: form sent → form_dikirim, set type from product_type
      try {
        const engine = require('./pipelineEngine');
        const typeMap = { papan: 'papan', bouquet: 'bouquet', parsel: 'parsel', cake: 'cake' };
        const mapped = typeMap[type] || 'unknown';
        if (mapped !== 'unknown') await engine.setType(pg, conv.id, mapped);
        await engine.apply(pg, conv.id, { type: 'order_url_sent' }, {
          source: 'auto:order_url_sent',
          metadata: { product_type: type, ref: utmRef },
        });
      } catch (err) {
        // Use console since this module may not have logger imported
        console.warn('[pipeline] order_url hook failed:', err.message);
      }
```

(If `logger` is already imported in aiTools.js, prefer `logger.warn(...)`.)

- [ ] **Step 9.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
pm2 logs crm-pilot-backend --lines 5 --nostream 2>&1 | tail -5
```

- [ ] **Step 9.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/services/aiTools.js && git commit -m "feat(pipeline): hook order_url_sent event + set type from build_order_form_url"
```

---

## Task 10: Hook — funnel submitted → order_submitted

**Files:**
- Modify: `/home/krttpt/crm/backend/routes/funnel.js`

- [ ] **Step 10.1: Update funnel route**

Edit `/home/krttpt/crm/backend/routes/funnel.js`. After the existing `INSERT INTO crm_link_events` and before `res.json(...)`, add:

```js
  // Pipeline: form_submitted → order_submitted (only for 'submitted' event)
  if (event === 'submitted' && convId) {
    try {
      const engine = require('../services/pipelineEngine');
      // Try to find matching MySQL order to fill value
      let orderId = null, value = null;
      try {
        const mysql = require('../db/mysql');
        const [orders] = await mysql.query(
          `SELECT id, total FROM \`order\` WHERE utm_content = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
          [refStr]
        );
        if (orders[0]) {
          orderId = orders[0].id;
          value = Number(orders[0].total) || null;
        }
      } catch {}
      if (orderId) await engine.fillFromOrder(pg, convId, orderId, value);
      await engine.apply(pg, convId, { type: 'order_submitted' }, {
        source: 'auto:funnel_submitted',
        metadata: { ref: refStr, order_id: orderId, value },
      });
    } catch (err) {
      console.warn('[pipeline] funnel hook failed:', err.message);
    }
  }
```

- [ ] **Step 10.2: Restart + manual test**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
# Optional manual hit (replace ref with a known one from your DB):
# curl -X POST http://localhost:3009/api/funnel/event -H 'Content-Type: application/json' -d '{"ref":"t-1-abc","event":"submitted"}' -w "\nHTTP %{http_code}\n"
```

- [ ] **Step 10.3: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/funnel.js && git commit -m "feat(pipeline): hook order_submitted event from funnel + fill value from MySQL order"
```

---

## Task 11: Hook — deliveryComms paid + delivered → paid/delivered

**Files:**
- Modify: `/home/krttpt/crm/backend/scripts/deliveryComms.js`

- [ ] **Step 11.1: Locate paid + post-delivery handlers**

```bash
grep -n "processPaidConfirm\|processPostDelivery\|sendPush.*paid_confirm\|sendPush.*post_delivery" /home/krttpt/crm/backend/scripts/deliveryComms.js | head -10
```

- [ ] **Step 11.2: Add pipeline hook in `processPaidConfirm`**

In the loop inside `processPaidConfirm`, **after** `const r = await sendPush({ orderId: o.id, kind: 'paid_confirm', ... })`, add:

```js
    if (conv) {
      try {
        const engine = require('../services/pipelineEngine');
        await engine.apply(pg, conv.id, { type: 'order_paid' }, {
          source: 'auto:order_paid',
          metadata: { order_id: o.id },
        });
      } catch (err) { logger.warn({ err: err.message }, '[pipeline] order_paid hook failed'); }
    }
```

- [ ] **Step 11.3: Add pipeline hook in `processPostDelivery`**

Same pattern, in `processPostDelivery` after `const r = await sendPush({ orderId: o.id, kind: 'post_delivery', ... })`:

```js
    if (conv) {
      try {
        const engine = require('../services/pipelineEngine');
        await engine.apply(pg, conv.id, { type: 'order_delivered' }, {
          source: 'auto:order_delivered',
          metadata: { order_id: o.id },
        });
      } catch (err) { logger.warn({ err: err.message }, '[pipeline] order_delivered hook failed'); }
    }
```

- [ ] **Step 11.4: Smoke run**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node scripts/deliveryComms.js 2>&1 | tail -5
```

Expected: no errors, normal "no orders found" if no recent paid/delivered.

- [ ] **Step 11.5: Commit**

```bash
cd /home/krttpt/crm && git add backend/scripts/deliveryComms.js && git commit -m "feat(pipeline): hook order_paid + order_delivered events from deliveryComms cron"
```

---

## Task 12: Hook — handover refund/cancel resolve → lost

**Files:**
- Modify: `/home/krttpt/crm/backend/routes/inbox.js`

- [ ] **Step 12.1: Find handover resolve endpoint**

```bash
grep -n "/handovers/.*resolve\|resolved_at" /home/krttpt/crm/backend/routes/inbox.js | head -10
```

- [ ] **Step 12.2: Add pipeline hook**

After the `UPDATE crm_handovers SET resolved_at = now()` query in the resolve endpoint, add:

```js
  // Pipeline: refund/cancel handover resolved → lost
  try {
    const ho = await pg.query(`SELECT conversation_id, reason FROM crm_handovers WHERE id = $1`, [id]);
    const reason = ho.rows[0]?.reason;
    const convId = ho.rows[0]?.conversation_id;
    if (convId && (reason === 'refund' || reason === 'cancel')) {
      const engine = require('../services/pipelineEngine');
      await engine.apply(pg, convId, {
        type: reason === 'refund' ? 'handover_refund' : 'handover_cancel',
      }, {
        source: 'auto:handover_resolved',
        staffId: req.staff.staff_id,
        lostReason: reason === 'refund' ? 'refund_complaint' : 'cancelled',
      });
    }
  } catch (err) {
    console.warn('[pipeline] handover resolve hook failed:', err.message);
  }
```

- [ ] **Step 12.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
pm2 logs crm-pilot-backend --lines 5 --nostream 2>&1 | tail -5
```

- [ ] **Step 12.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/inbox.js && git commit -m "feat(pipeline): hook lost on refund/cancel handover resolve"
```

---

## Task 13: Hook — spam filter → lost

**Files:**
- Modify: `/home/krttpt/crm/backend/routes/webhook.js` (where spam filter is invoked)

- [ ] **Step 13.1: Locate spam filter call site**

```bash
grep -n "spamFilter\|spamSkipped\|spam_block" /home/krttpt/crm/backend/routes/webhook.js | head -10
```

- [ ] **Step 13.2: Add pipeline hook in spam-block branch**

In the block where `spamSkipped = true` (after `INSERT INTO crm_handovers`), add:

```js
        // Pipeline: spam_blocked → lost
        try {
          const engine = require('../services/pipelineEngine');
          await engine.apply(client, conv.id, { type: 'spam_blocked' }, {
            source: 'auto:spam_filter',
            lostReason: 'other_with_note',
            lostNote: `spam_block: ${r.reason}${r.pattern ? ' (' + r.pattern + ')' : ''}`,
            metadata: { reason: r.reason, pattern: r.pattern },
          });
        } catch (err) { console.warn('[pipeline] spam hook failed:', err.message); }
```

- [ ] **Step 13.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
pm2 logs crm-pilot-backend --lines 5 --nostream 2>&1 | tail -5
```

- [ ] **Step 13.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/webhook.js && git commit -m "feat(pipeline): hook spam_blocked → lost"
```

---

## Task 14: Hook — operator claim → tertarik

**Files:**
- Modify: `/home/krttpt/crm/backend/routes/users.js`

- [ ] **Step 14.1: Locate claim endpoint**

```bash
grep -n "/conversations/:id/claim\|crm_conversation_claims" /home/krttpt/crm/backend/routes/users.js | head -5
```

- [ ] **Step 14.2: Add hook after successful claim insert**

After the `ON CONFLICT (conversation_id) DO UPDATE` block in the claim endpoint, before `res.json({...})`, add:

```js
  // Pipeline: operator_claim event (only transitions baru→tertarik)
  try {
    const engine = require('../services/pipelineEngine');
    await engine.apply(pg, convId, { type: 'operator_claim' }, {
      source: 'auto:operator_claim',
      staffId: req.staff.staff_id,
    });
  } catch (err) { console.warn('[pipeline] claim hook failed:', err.message); }
```

- [ ] **Step 14.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
```

- [ ] **Step 14.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/users.js && git commit -m "feat(pipeline): hook operator_claim → tertarik (baru only)"
```

---

## Task 15: Hook — tag attach with maps_to_pipeline_type or VIP/Loyal

**Files:**
- Modify: `/home/krttpt/crm/backend/routes/operatorTools.js`

- [ ] **Step 15.1: Locate tag set endpoint**

```bash
grep -n "/conversations/:id/tags\|crm_conversation_tags" /home/krttpt/crm/backend/routes/operatorTools.js | head -5
```

- [ ] **Step 15.2: Add hook after tag attach**

In the route handler that attaches tags (POST `/conversations/:id/tags`), after the bulk INSERT loop, add:

```js
  // Pipeline: tag-driven side effects
  try {
    const engine = require('../services/pipelineEngine');
    // 1) Tags with maps_to_pipeline_type set the type (only if current type='unknown')
    const mapped = await pg.query(
      `SELECT t.maps_to_pipeline_type FROM crm_tags t
       JOIN crm_conversation_tags ct ON ct.tag_id = t.id
       WHERE ct.conversation_id = $1 AND t.maps_to_pipeline_type IS NOT NULL
       ORDER BY t.id LIMIT 1`,
      [id]
    );
    if (mapped.rows[0]?.maps_to_pipeline_type) {
      await engine.setType(pg, id, mapped.rows[0].maps_to_pipeline_type);
    }
    // 2) Tags named like VIP/Loyal/Korporat → set manual_stage_override=true (cegah auto-Lost)
    const flagged = await pg.query(
      `SELECT 1 FROM crm_tags t JOIN crm_conversation_tags ct ON ct.tag_id = t.id
       WHERE ct.conversation_id = $1 AND LOWER(t.name) ~ 'vip|loyal|korporat'
       LIMIT 1`, [id]
    );
    if (flagged.rows.length) {
      await pg.query(`UPDATE crm_conversations SET manual_stage_override = TRUE WHERE id = $1`, [id]);
    }
  } catch (err) { console.warn('[pipeline] tag hook failed:', err.message); }
```

- [ ] **Step 15.3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
sleep 2
```

- [ ] **Step 15.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/operatorTools.js && git commit -m "feat(pipeline): hook tag attach — type via mapping + override flag for VIP/loyal/korporat"
```

---

## Task 16: Hook — recurringSuggestion sets type from MySQL category

**Files:**
- Modify: `/home/krttpt/crm/backend/scripts/recurringSuggestion.js`

- [ ] **Step 16.1: Locate recurring suggestion creation**

```bash
grep -n "INSERT INTO crm_followups\|recurring_suggestion" /home/krttpt/crm/backend/scripts/recurringSuggestion.js | head -5
```

- [ ] **Step 16.2: Add type infer + setType after insert**

After the `INSERT INTO crm_followups` for `recurring_suggestion` kind, add (inside the same loop that has `conv.conversation_id`):

```js
      // Pipeline: infer pipeline_type from this customer's past order_items category
      try {
        const [cat] = await mysql.query(
          `SELECT LOWER(c.name) AS category FROM order_items oi
           JOIN \`order\` o ON o.id = oi.order_id
           LEFT JOIN products p ON p.id = oi.product_id
           LEFT JOIN product_category_new c ON c.id = p.category_id
           WHERE o.customer_id = ? AND oi.deleted_at IS NULL AND o.deleted_at IS NULL
             AND oi.receiver_name = ?
           ORDER BY oi.id DESC LIMIT 1`,
          [conv.customer_id, h.receiver_name]
        );
        const map = { 'papan duka': 'papan', 'papan': 'papan', 'bouquet': 'bouquet', 'parsel': 'parsel', 'cake': 'cake', 'kue': 'cake' };
        const catName = (cat[0]?.category || '').toLowerCase();
        let mapped = 'unknown';
        for (const k of Object.keys(map)) if (catName.includes(k)) { mapped = map[k]; break; }
        if (mapped !== 'unknown') {
          const engine = require('../services/pipelineEngine');
          await engine.setType(pg, conv.conversation_id, mapped);
        }
      } catch (err) { logger.warn({ err: err.message }, '[pipeline] recurring type-infer failed'); }
```

- [ ] **Step 16.3: Smoke run**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node scripts/recurringSuggestion.js 2>&1 | tail -5
```

- [ ] **Step 16.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/scripts/recurringSuggestion.js && git commit -m "feat(pipeline): set type from MySQL category in recurring suggestion"
```

---

## Task 17: Hook — snooze/unsnooze pause clock for stale-lost

The pause logic doesn't change snooze code itself — it changes the watcher in Task 18 to skip currently-snoozed convs. No code edit here. **Skip task — covered in Task 18.**

---

## Task 18: pipelineWatcher cron — auto-Lost stale deals

**Files:**
- Create: `/home/krttpt/crm/backend/scripts/pipelineWatcher.js`

- [ ] **Step 18.1: Create script**

Create `/home/krttpt/crm/backend/scripts/pipelineWatcher.js`:

```js
// Pipeline watcher — every hour. Auto-Lost stale deals:
//   stage in (tertarik, form_dikirim) + last_message_at < now - 3 days → lost reason=no_reply
//   stage = baru + last_message_at < now - 7 days → lost reason=no_reply
// Skips conversations currently snoozed (snoozed_until > now()).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const engine = require('../services/pipelineEngine');
const logger = require('../services/logger');

async function processStale(stages, daysThreshold, eventType) {
  const { rows } = await pg.query(
    `SELECT id FROM crm_conversations
     WHERE pipeline_stage = ANY($1::varchar[])
       AND COALESCE(snoozed_until, '1970-01-01'::timestamptz) < now()
       AND last_message_at < now() - ($2 || ' days')::interval`,
    [stages, String(daysThreshold)]
  );
  let lost = 0;
  for (const r of rows) {
    try {
      const result = await engine.apply(pg, r.id, { type: eventType }, {
        source: 'auto:stale_watcher',
        lostReason: 'no_reply',
      });
      if (result.applied) lost++;
    } catch (err) { logger.warn({ err: err.message, conv_id: r.id }, '[watcher] one failed'); }
  }
  return lost;
}

async function run() {
  const lost1 = await processStale(['tertarik', 'form_dikirim'], 3, 'stale_no_reply');
  const lost2 = await processStale(['baru'], 7, 'stale_baru_no_reply');
  logger.info({ lost_active: lost1, lost_baru: lost2 }, '[watcher] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[watcher] failed'); process.exit(1); });
}

module.exports = { run };
```

- [ ] **Step 18.2: Smoke run**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node scripts/pipelineWatcher.js 2>&1 | tail -5
```

Expected: `[watcher] done` with `lost_active: N, lost_baru: M` (likely 0 on fresh data).

- [ ] **Step 18.3: Commit**

```bash
cd /home/krttpt/crm && git add backend/scripts/pipelineWatcher.js && git commit -m "feat(pipeline): pipelineWatcher cron — auto-Lost stale deals (snooze-aware)"
```

---

## Task 19: pipelineBackfill script

**Files:**
- Create: `/home/krttpt/crm/backend/scripts/pipelineBackfill.js`

- [ ] **Step 19.1: Create backfill script**

Create `/home/krttpt/crm/backend/scripts/pipelineBackfill.js`:

```js
// One-shot backfill: assign pipeline_stage to every existing conversation
// based on history available. Run AFTER migration 013 applied.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('../services/logger');
const { TYPES } = require('../services/pipelineConstants');

const BATCH = 500;

async function inferStageForConv(c) {
  // Returns { stage, lost_reason, lost_note, type, deal_order_id, deal_value_idr }
  const out = { stage: null, lost_reason: null, lost_note: null, type: 'unknown', deal_order_id: null, deal_value_idr: null };

  // Spam check
  const spam = await pg.query(`SELECT 1 FROM crm_spam_blocks WHERE phone = $1 AND released_at IS NULL`, [c.phone]);
  if (spam.rows.length) { out.stage = 'lost'; out.lost_reason = 'other_with_note'; out.lost_note = 'spam_block'; return out; }

  // Closed + handover refund
  const refund = await pg.query(
    `SELECT 1 FROM crm_handovers WHERE conversation_id = $1 AND reason = 'refund' AND resolved_at IS NOT NULL LIMIT 1`,
    [c.id]
  );
  if (refund.rows.length) { out.stage = 'lost'; out.lost_reason = 'refund_complaint'; return out; }

  // Closed + handover cancel
  const cancel = await pg.query(
    `SELECT 1 FROM crm_handovers WHERE conversation_id = $1 AND reason = 'cancel' AND resolved_at IS NOT NULL LIMIT 1`,
    [c.id]
  );
  if (cancel.rows.length) { out.stage = 'lost'; out.lost_reason = 'cancelled'; return out; }

  // Try MySQL order match by UTM ref
  if (c.last_order_url_ref) {
    try {
      const [orders] = await mysql.query(
        `SELECT o.id, o.total, o.payment_status, MAX(oi.date_time) AS delivery_date,
                LOWER(MAX(c.name)) AS category
         FROM \`order\` o
         LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_category_new c ON c.id = p.category_id
         WHERE o.utm_content = ? AND o.deleted_at IS NULL
         GROUP BY o.id, o.total, o.payment_status
         ORDER BY o.id DESC LIMIT 1`,
        [c.last_order_url_ref]
      );
      if (orders[0]) {
        out.deal_order_id = orders[0].id;
        out.deal_value_idr = Number(orders[0].total) || null;
        const cat = orders[0].category || '';
        const map = { 'papan': 'papan', 'bouquet': 'bouquet', 'parsel': 'parsel', 'cake': 'cake', 'kue': 'cake' };
        for (const k of Object.keys(map)) if (cat.includes(k)) { out.type = map[k]; break; }
        if (orders[0].payment_status === 'paid' && orders[0].delivery_date && new Date(orders[0].delivery_date) <= new Date()) {
          out.stage = 'delivered'; return out;
        }
        if (orders[0].payment_status === 'paid') { out.stage = 'paid'; return out; }
        out.stage = 'order_submitted'; return out;
      }
    } catch (err) { /* mysql query failed; continue with other branches */ }
  }

  const lastMsgAge = c.last_message_at ? (Date.now() - new Date(c.last_message_at).getTime()) / 86400000 : 999;

  if (c.last_order_url_sent_at) {
    if (lastMsgAge > 3) { out.stage = 'lost'; out.lost_reason = 'no_reply'; return out; }
    out.stage = 'form_dikirim'; return out;
  }

  // Closed + staff outbound → delivered
  if (c.status === 'closed') {
    const staffOut = await pg.query(
      `SELECT 1 FROM crm_messages WHERE conversation_id = $1 AND direction = 'out' AND sender_type = 'staff' LIMIT 1`,
      [c.id]
    );
    if (staffOut.rows.length) { out.stage = 'delivered'; return out; }
  }

  if (c.assigned_staff_id && lastMsgAge < 7) { out.stage = 'tertarik'; return out; }

  if (['order_intent', 'pricing', 'shipping', 'payment'].includes(c.last_intent)) {
    if (lastMsgAge > 3) { out.stage = 'lost'; out.lost_reason = 'no_reply'; return out; }
    out.stage = 'tertarik'; return out;
  }

  if (lastMsgAge > 7) { out.stage = 'lost'; out.lost_reason = 'no_reply'; return out; }
  out.stage = 'baru';
  return out;
}

async function processBatch(offset) {
  const { rows } = await pg.query(
    `SELECT id, phone, status, last_message_at, last_intent, last_order_url_sent_at,
            last_order_url_ref, assigned_staff_id, customer_id
     FROM crm_conversations
     ORDER BY id LIMIT $1 OFFSET $2`,
    [BATCH, offset]
  );
  if (!rows.length) return 0;
  const counters = {};
  for (const c of rows) {
    const out = await inferStageForConv(c);
    const histEntry = JSON.stringify({
      stage: out.stage, at: c.last_message_at || new Date().toISOString(), by: null, source: 'backfill',
    });
    await pg.query(
      `UPDATE crm_conversations SET
         pipeline_stage = $2,
         pipeline_stage_at = COALESCE(last_message_at, now()),
         pipeline_type = $3,
         deal_order_id = $4,
         deal_value_idr = $5,
         lost_reason = $6,
         lost_note = $7,
         pipeline_stage_history = $8::jsonb
       WHERE id = $1`,
      [c.id, out.stage, out.type, out.deal_order_id, out.deal_value_idr, out.lost_reason, out.lost_note, '[' + histEntry + ']']
    );
    await pg.query(
      `INSERT INTO crm_pipeline_events (conversation_id, from_stage, to_stage, source, metadata)
       VALUES ($1, NULL, $2, 'backfill', $3::jsonb)`,
      [c.id, out.stage, JSON.stringify({ inferred_type: out.type })]
    );
    counters[out.stage] = (counters[out.stage] || 0) + 1;
  }
  logger.info({ batch_offset: offset, count: rows.length, by_stage: counters }, '[backfill] batch done');
  return rows.length;
}

async function run() {
  const total = (await pg.query(`SELECT COUNT(*)::int AS n FROM crm_conversations`)).rows[0].n;
  logger.info({ total }, '[backfill] starting');
  let offset = 0;
  while (true) {
    const n = await processBatch(offset);
    if (n < BATCH) break;
    offset += BATCH;
  }
  // Summary
  const summary = await pg.query(
    `SELECT pipeline_stage, COUNT(*)::int AS n FROM crm_conversations GROUP BY pipeline_stage ORDER BY pipeline_stage`
  );
  logger.info({ summary: summary.rows }, '[backfill] done');
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message, stack: err.stack }, '[backfill] failed'); process.exit(1); });
}
module.exports = { run, inferStageForConv };
```

- [ ] **Step 19.2: Run backfill**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node scripts/pipelineBackfill.js 2>&1 | tail -20
```

Expected: `[backfill] starting`, several `[backfill] batch done`, then `[backfill] done` with summary array showing distribution per stage.

- [ ] **Step 19.3: Sanity check distribution**

```bash
eval "$(grep -E '^PG_(HOST|PORT|DATABASE|USER|PASSWORD)=' /home/krttpt/crm/.env | sed 's/=\(.*\)$/=\"\1\"/')" && \
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" -c \
"SELECT pipeline_stage, COUNT(*) FROM crm_conversations GROUP BY pipeline_stage ORDER BY pipeline_stage"
```

Verify: distribution makes sense. If `lost > 70%` of total, review `last_message_at` data quality.

- [ ] **Step 19.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/scripts/pipelineBackfill.js && git commit -m "feat(pipeline): one-shot backfill script + initial backfill run"
```

---

## Task 20: Anomaly detector + daily brief extension

**Files:**
- Modify: `/home/krttpt/crm/backend/scripts/anomalyDetector.js`
- Modify: `/home/krttpt/crm/backend/scripts/dailyBrief.js`

- [ ] **Step 20.1: Add pipeline_stale_form_dikirim check to anomaly detector**

Edit `/home/krttpt/crm/backend/scripts/anomalyDetector.js`. In the `checks` array, append:

```js
    {
      kind: 'pipeline_stale_form_dikirim', label: 'Deal stuck di Form Dikirim',
      lastHourSql: `SELECT COUNT(*)::int AS n FROM crm_conversations
                    WHERE pipeline_stage='form_dikirim'
                      AND pipeline_stage_at < now() - interval '24 hours'`,
      baselineSql: `SELECT 0::int AS n`, // absolute threshold
    },
```

Then change the spike condition. After the `const r = await checkKind(c);` add a special case:

```js
    if (c.kind === 'pipeline_stale_form_dikirim') {
      // Use absolute threshold: alert if >10
      r.isSpike = r.lastN > 10;
    }
```

(Place this BEFORE `if (!r.isSpike) continue;`.)

- [ ] **Step 20.2: Add pipeline block to daily brief**

Edit `/home/krttpt/crm/backend/scripts/dailyBrief.js`. Find the `Promise.all([...])` block of queries. Add to the array:

```js
    pg.query(`
      SELECT pipeline_stage, COUNT(*)::int AS n FROM crm_conversations
      WHERE pipeline_stage NOT IN ('delivered','lost') OR pipeline_stage_at > now() - interval '7 days'
      GROUP BY pipeline_stage`),
    pg.query(`
      SELECT lost_reason, COUNT(*)::int AS n FROM crm_conversations
      WHERE pipeline_stage = 'lost' AND pipeline_stage_at > now() - interval '24 hours' AND lost_reason IS NOT NULL
      GROUP BY lost_reason ORDER BY n DESC LIMIT 3`),
```

Add corresponding destructuring after the await (the existing code does `const o = overall.rows[0]; ...` — append at the end):

```js
  const pipeline = arguments[0]; // adjust based on actual destructure pattern; if Promise.all uses destructuring, capture last 2
  // Build pipeline section
  const pipelineLines = pipelineByStage.rows.map(r => `  • ${r.pipeline_stage}: ${r.n}`).join('\n') || '  (kosong)';
  const lostLines = lostReasons.rows.map(r => `  • ${r.lost_reason}: ${r.n}`).join('\n') || '  (tidak ada)';
```

Then in the `body` template literal, add:

```
🎯 <b>Pipeline today</b>
${pipelineLines}

😞 <b>Top Lost reason 24h</b>
${lostLines}
```

(If you'd rather rewrite `dailyBrief.js` cleanly with named consts instead of `arguments[0]`, do so — match local style of the file.)

- [ ] **Step 20.3: Smoke**

```bash
cd /home/krttpt/crm/backend && /usr/bin/node scripts/anomalyDetector.js 2>&1 | tail -5
cd /home/krttpt/crm/backend && /usr/bin/node scripts/dailyBrief.js 2>&1 | tail -5
```

- [ ] **Step 20.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/scripts/anomalyDetector.js backend/scripts/dailyBrief.js && git commit -m "feat(pipeline): extend anomaly + daily brief with pipeline metrics"
```

---

## Task 21: Cron entry for pipelineWatcher

**Files:**
- Modify: `/etc/cron.d/crm-pilot` (system cron, requires sudo)

- [ ] **Step 21.1: Read current cron**

```bash
cat /etc/cron.d/crm-pilot
```

- [ ] **Step 21.2: Add pipeline watcher entry**

Create updated file at `/tmp/crm-pilot.cron` with the existing content + new line:

```
# Pipeline watcher (1×/jam — auto-Lost stale deals)
7 * * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/pipelineWatcher.js >> /home/krttpt/crm/logs/cron-pipeline.log 2>&1
```

(Insert above `# Weekly audit` line; keeps everything else intact.)

- [ ] **Step 21.3: Install + reload**

```bash
sudo install -m 0644 -o root -g root /tmp/crm-pilot.cron /etc/cron.d/crm-pilot && sudo service cron reload 2>&1 | tail -1
```

- [ ] **Step 21.4: Verify**

```bash
grep pipelineWatcher /etc/cron.d/crm-pilot
```

Expected: line present.

- [ ] **Step 21.5: Commit (cron template, if tracked in repo)**

The cron file may not be in git, but if you keep a template:

```bash
cd /home/krttpt/crm && git add scripts/cron-template.txt 2>/dev/null || true
git commit --allow-empty -m "chore(cron): add pipelineWatcher (hourly)"
```

---

## Task 22: Frontend — Layout nav + shared PipelineStageBadge

**Files:**
- Modify: `/home/krttpt/crm/frontend/src/components/Layout.jsx`
- Create: `/home/krttpt/crm/frontend/src/components/PipelineStageBadge.jsx`

- [ ] **Step 22.1: Add nav item**

Edit `/home/krttpt/crm/frontend/src/components/Layout.jsx`. Find the `navItems` array and insert after `/inbox` line:

```js
  { href: '/pipeline',        label: 'Pipeline',  short: 'Pipe' },
```

Order it right after Inbox so it sits prominently.

- [ ] **Step 22.2: Create PipelineStageBadge component**

Create `/home/krttpt/crm/frontend/src/components/PipelineStageBadge.jsx`:

```jsx
const STAGE_COLOR = {
  baru:            'bg-slate-100 text-slate-700 border-slate-200',
  tertarik:        'bg-blue-100 text-blue-700 border-blue-200',
  form_dikirim:    'bg-indigo-100 text-indigo-700 border-indigo-200',
  order_submitted: 'bg-violet-100 text-violet-700 border-violet-200',
  paid:            'bg-emerald-100 text-emerald-700 border-emerald-200',
  delivered:       'bg-teal-100 text-teal-700 border-teal-200',
  lost:            'bg-rose-100 text-rose-700 border-rose-200',
};

const STAGE_LABEL = {
  baru: 'Baru',
  tertarik: 'Tertarik',
  form_dikirim: 'Form Dikirim',
  order_submitted: 'Submitted',
  paid: 'Paid',
  delivered: 'Delivered',
  lost: 'Lost',
};

export default function PipelineStageBadge({ stage, override, size = 'sm', title }) {
  if (!stage) return null;
  const cls = STAGE_COLOR[stage] || STAGE_COLOR.baru;
  const sz = size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${cls} ${sz}`} title={title || stage}>
      {STAGE_LABEL[stage] || stage}
      {override && <span aria-hidden title="manual override">🔒</span>}
    </span>
  );
}

export { STAGE_COLOR, STAGE_LABEL };
```

- [ ] **Step 22.3: Quick build sanity**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -8
```

Expected: success.

- [ ] **Step 22.4: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/Layout.jsx frontend/src/components/PipelineStageBadge.jsx && git commit -m "feat(pipeline): nav + shared PipelineStageBadge"
```

---

## Task 23: Frontend — Inbox list integration (badge column + filter)

**Files:**
- Modify: `/home/krttpt/crm/frontend/src/pages/inbox/index.js`
- Modify: `/home/krttpt/crm/backend/routes/inbox.js` (expose pipeline_stage in list query)

- [ ] **Step 23.1: Backend — expose pipeline_stage in list query**

Edit `/home/krttpt/crm/backend/routes/inbox.js`. Find the `SELECT conv.id, conv.phone ...` (around line 60) for the conversations list. Add `pipeline_stage`, `pipeline_type`, `manual_stage_override` to the SELECT list:

```js
    SELECT conv.id, conv.phone, conv.real_phone, conv.push_name,
           conv.customer_id, conv.status, conv.ai_enabled,
           conv.ai_paused_until, conv.assigned_staff_id, conv.last_message_at,
           conv.last_intent, conv.handover_count, conv.shadow_mode,
           conv.snoozed_until, conv.snoozed_by,
           conv.pipeline_stage, conv.pipeline_type, conv.manual_stage_override,
           ...
```

Add stage filter support. Find the `where.push(...)` block. Add:

```js
  if (req.query.pipeline_stage) {
    params.push(req.query.pipeline_stage);
    where.push(`conv.pipeline_stage = $${params.length}`);
  }
```

Restart backend:

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
```

- [ ] **Step 23.2: Frontend — render badge in inbox row**

Edit `/home/krttpt/crm/frontend/src/pages/inbox/index.js`.

Add import at top:
```js
import PipelineStageBadge from '@/components/PipelineStageBadge';
```

In the row render (find where tags are rendered, around line 290-300), add badge:

```jsx
{conv.pipeline_stage && (
  <PipelineStageBadge stage={conv.pipeline_stage} override={conv.manual_stage_override} size="xs" />
)}
```

(Place before or after the tags chips — visually most appropriate.)

- [ ] **Step 23.3: Frontend — add stage filter to toolbar**

Find the toolbar with existing filters (queue/tag). Add dropdown:

```jsx
<select
  value={stageFilter || ''}
  onChange={(e) => setStageFilter(e.target.value)}
  className="text-xs px-2 py-1 border border-slate-200 rounded"
>
  <option value="">All stages</option>
  <option value="baru">Baru</option>
  <option value="tertarik">Tertarik</option>
  <option value="form_dikirim">Form Dikirim</option>
  <option value="order_submitted">Submitted</option>
  <option value="paid">Paid</option>
  <option value="delivered">Delivered</option>
  <option value="lost">Lost</option>
</select>
```

Add corresponding state: `const [stageFilter, setStageFilter] = useState('');` and include `pipeline_stage=${stageFilter}` in the SWR key.

- [ ] **Step 23.4: Build + smoke**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -5
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
```

- [ ] **Step 23.5: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/inbox.js frontend/src/pages/inbox/index.js && git commit -m "feat(pipeline): inbox list — stage badge column + filter"
```

---

## Task 24: Frontend — Chat detail header badge + revert button

**Files:**
- Modify: `/home/krttpt/crm/frontend/src/pages/inbox/[id].js`

- [ ] **Step 24.1: Add SWR for pipeline events + badge**

Edit `/home/krttpt/crm/frontend/src/pages/inbox/[id].js`.

Add import:
```js
import PipelineStageBadge from '@/components/PipelineStageBadge';
```

Add SWR for events (next to other useSWR calls):

```js
const pipelineEvents = useSWR(
  id ? `/api/pipeline/events?conversation_id=${id}&limit=5` : null,
  fetcher
);
```

In the chat header section (where status pills are rendered), add:

```jsx
{convData?.pipeline_stage && (
  <button
    onClick={() => router.push(`/pipeline?focus=${id}`)}
    title={`Stage: ${convData.pipeline_stage}${convData.manual_stage_override ? ' (manual override)' : ''}\nKlik untuk buka pipeline`}
  >
    <PipelineStageBadge stage={convData.pipeline_stage} override={convData.manual_stage_override} size="xs" />
  </button>
)}
```

Also add a "Revert stage" button right of the badge:

```jsx
{(pipelineEvents.data?.items?.length || 0) > 1 && (
  <button
    onClick={async () => {
      if (!confirm('Revert ke stage sebelumnya?')) return;
      try {
        await api(`/api/pipeline/conversations/${id}/revert-stage`, { method: 'POST' });
        toast.success('Stage di-revert');
        conv.mutate();
        pipelineEvents.mutate();
      } catch (e) { toast.error(e.message); }
    }}
    className="text-[10px] px-1.5 py-0.5 rounded text-slate-500 hover:bg-slate-100"
    title="Revert ke stage sebelumnya (audit history)"
  >↺</button>
)}
```

- [ ] **Step 24.2: Build + smoke**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -5
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
```

- [ ] **Step 24.3: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/pages/inbox/\[id\].js && git commit -m "feat(pipeline): chat header — stage badge + revert button"
```

---

## Task 25: Frontend — CustomerPanel Pipeline section

**Files:**
- Modify: `/home/krttpt/crm/frontend/src/components/CustomerPanel.jsx`

- [ ] **Step 25.1: Add Pipeline section**

Edit `/home/krttpt/crm/frontend/src/components/CustomerPanel.jsx`. Locate where Tags / Notes blocks are rendered. Add a new section `<PipelineBlock convId={...} stage={...} type={...} value={...} />`.

Define `PipelineBlock` component within the file (or in a new file if file gets too long):

```jsx
function PipelineBlock({ conv, onMutate }) {
  const toast = useToast();
  const [showLost, setShowLost] = useState(false);
  const [lostReason, setLostReason] = useState('no_reply');
  const [lostNote, setLostNote] = useState('');
  const [valueDraft, setValueDraft] = useState('');

  if (!conv) return null;

  async function setStage(stage) {
    try {
      await api(`/api/pipeline/conversations/${conv.id}/stage`, { method: 'POST', body: { stage } });
      toast.success(`Stage: ${stage}`);
      onMutate();
    } catch (e) { toast.error(e.message); }
  }

  async function setType(type) {
    try {
      await api(`/api/pipeline/conversations/${conv.id}/type`, { method: 'POST', body: { type } });
      toast.success(`Type: ${type}`);
      onMutate();
    } catch (e) { toast.error(e.message); }
  }

  async function markLost() {
    if (lostReason === 'other_with_note' && !lostNote.trim()) {
      toast.error('Note wajib untuk other_with_note');
      return;
    }
    try {
      await api(`/api/pipeline/conversations/${conv.id}/stage`, {
        method: 'POST', body: { stage: 'lost', lost_reason: lostReason, lost_note: lostNote || null }
      });
      toast.success('Marked Lost');
      setShowLost(false);
      setLostNote('');
      onMutate();
    } catch (e) { toast.error(e.message); }
  }

  async function saveValue() {
    const v = parseInt(valueDraft);
    if (!v || v < 0) return toast.error('value must be positive number');
    try {
      await api(`/api/pipeline/conversations/${conv.id}/value`, { method: 'POST', body: { value_idr: v, lock: true } });
      toast.success('Deal value saved');
      setValueDraft('');
      onMutate();
    } catch (e) { toast.error(e.message); }
  }

  const STAGES = ['baru', 'tertarik', 'form_dikirim', 'order_submitted', 'paid', 'delivered'];
  const TYPES = ['unknown', 'papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b'];
  const LOST_REASONS = ['no_reply', 'harga_terlalu_tinggi', 'kompetitor', 'produk_tidak_cocok', 'timing_tidak_pas', 'cancelled', 'refund_complaint', 'other_with_note'];
  const isHighValue = ['wedding', 'b2b'].includes(conv.pipeline_type);

  return (
    <section className="space-y-2">
      <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Pipeline</div>
      <div className="bg-white rounded-md border border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Stage</span>
          <select value={conv.pipeline_stage} onChange={(e) => setStage(e.target.value)}
            className="text-xs px-1 py-0.5 border border-slate-200 rounded">
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            <option value="lost">lost</option>
          </select>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Type</span>
          <select value={conv.pipeline_type || 'unknown'} onChange={(e) => setType(e.target.value)}
            className="text-xs px-1 py-0.5 border border-slate-200 rounded">
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">Deal value</span>
          <span className="font-medium text-slate-700">
            {conv.deal_value_idr ? `Rp ${Number(conv.deal_value_idr).toLocaleString('id-ID')}` : '—'}
          </span>
        </div>
        {isHighValue && (
          <div className="flex gap-1">
            <input value={valueDraft} onChange={(e) => setValueDraft(e.target.value)} placeholder="Manual value (Rp)"
              className="flex-1 text-xs px-1.5 py-1 border border-slate-200 rounded" type="number" />
            <button onClick={saveValue} className="text-xs px-2 py-1 rounded bg-brand-500 text-white">Set</button>
          </div>
        )}
        <button onClick={() => setShowLost(!showLost)}
          className="w-full text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50">
          {showLost ? 'Tutup' : 'Mark Lost…'}
        </button>
        {showLost && (
          <div className="space-y-1">
            <select value={lostReason} onChange={(e) => setLostReason(e.target.value)}
              className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded">
              {LOST_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {lostReason === 'other_with_note' && (
              <textarea value={lostNote} onChange={(e) => setLostNote(e.target.value)} rows={2}
                placeholder="Note (wajib)" className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded" />
            )}
            <button onClick={markLost} className="w-full text-xs px-2 py-1 rounded bg-rose-500 text-white hover:bg-rose-600">
              Konfirmasi Lost
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
```

Render `<PipelineBlock conv={profile} onMutate={() => mutate()} />` in the panel. Adapt prop names to match the local `useSWR` data variable names in the file.

- [ ] **Step 25.2: Build + smoke**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -5
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
```

- [ ] **Step 25.3: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/CustomerPanel.jsx && git commit -m "feat(pipeline): CustomerPanel — Pipeline section with stage/type/value/Mark Lost"
```

---

## Task 26: Frontend — AI monitor "Pipeline summary" card

**Files:**
- Modify: `/home/krttpt/crm/frontend/src/pages/ai-monitor.js`

- [ ] **Step 26.1: Add SWR + card**

Edit `/home/krttpt/crm/frontend/src/pages/ai-monitor.js`. Add SWR (next to other useSWR calls):

```js
const pipelineSummary = useSWR('/api/pipeline/forecast?days=30', fetcher, { refreshInterval: 5 * 60_000 });
```

Add a new card in the grid (next to existing CSAT/Eval cards):

```jsx
<div className="bg-white border border-slate-200 rounded-lg p-5">
  <h2 className="text-sm font-semibold text-slate-700 mb-3">Pipeline summary 30d</h2>
  {pipelineSummary.data ? (
    <>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <div className="rounded bg-brand-50 border border-brand-200 px-2 py-1.5">
          <div className="text-slate-500">Expected revenue</div>
          <div className="font-semibold text-brand-800">Rp {Number(pipelineSummary.data.expected_revenue).toLocaleString('id-ID')}</div>
        </div>
        <div className="rounded bg-emerald-50 border border-emerald-200 px-2 py-1.5">
          <div className="text-slate-500">Realized 30d</div>
          <div className="font-semibold text-emerald-800">Rp {Number(pipelineSummary.data.realized_revenue_30d).toLocaleString('id-ID')}</div>
        </div>
      </div>
      <ul className="space-y-1 text-xs">
        {Object.entries(pipelineSummary.data.by_stage || {}).map(([stage, d]) => (
          <li key={stage} className="flex items-center justify-between">
            <span className="text-slate-600">{stage}</span>
            <span className="font-medium text-slate-800">{d.count}</span>
          </li>
        ))}
      </ul>
      <div className="text-[11px] text-slate-500 mt-2">
        form_dikirim → paid: <b>{Math.round((pipelineSummary.data.conversion_rates?.['form_dikirim→order_submitted'] || 0) * (pipelineSummary.data.conversion_rates?.['order_submitted→paid'] || 0) * 100)}%</b>
      </div>
    </>
  ) : <div className="text-sm text-slate-400">Loading…</div>}
</div>
```

- [ ] **Step 26.2: Build + smoke**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -5
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
```

- [ ] **Step 26.3: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/pages/ai-monitor.js && git commit -m "feat(pipeline): ai-monitor — Pipeline summary card"
```

---

## Task 27: Frontend — Tags page maps_to_pipeline_type column

**Files:**
- Modify: `/home/krttpt/crm/frontend/src/pages/tags.js`
- Modify: `/home/krttpt/crm/backend/routes/operatorTools.js`

- [ ] **Step 27.1: Backend — accept maps_to_pipeline_type in tag CRUD**

Edit `/home/krttpt/crm/backend/routes/operatorTools.js`. Find tag CREATE / UPDATE endpoints. Add `maps_to_pipeline_type` to the column list in INSERT/UPDATE.

For CREATE (look for existing `INSERT INTO crm_tags ... VALUES`):
```js
INSERT INTO crm_tags (name, color, description, maps_to_pipeline_type) VALUES ($1, $2, $3, $4)
```
Update params accordingly. Validate against TYPES array (use the constant).

For LIST (return all columns):
```js
SELECT id, name, color, description, maps_to_pipeline_type, ... FROM crm_tags
```

- [ ] **Step 27.2: Frontend — add dropdown in tags.js**

Edit `/home/krttpt/crm/frontend/src/pages/tags.js`. Add `maps_to_pipeline_type` to draft state and editing state. Add a column to the SimpleTable + edit modal:

```jsx
const TYPES = ['', 'papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b'];
// In edit form:
<label className="text-xs text-slate-500 block">
  Maps to deal type (untuk auto-set pipeline type)
  <select value={editing.maps_to_pipeline_type || ''}
    onChange={(e) => setEditing({ ...editing, maps_to_pipeline_type: e.target.value || null })}
    className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm">
    {TYPES.map((t) => <option key={t} value={t}>{t || '(none)'}</option>)}
  </select>
</label>
```

In SimpleTable columns, add:
```js
{ key: 'maps_to_pipeline_type', label: 'Deal type',
  render: (r) => r.maps_to_pipeline_type ? <code className="text-xs bg-slate-100 px-1 rounded">{r.maps_to_pipeline_type}</code> : <span className="text-slate-300 text-xs">—</span> },
```

- [ ] **Step 27.3: Build + restart + smoke**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -5
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
```

- [ ] **Step 27.4: Commit**

```bash
cd /home/krttpt/crm && git add backend/routes/operatorTools.js frontend/src/pages/tags.js && git commit -m "feat(pipeline): tags — maps_to_pipeline_type column for type mapping"
```

---

## Task 28: Frontend — PipelineCard component

**Files:**
- Create: `/home/krttpt/crm/frontend/src/components/PipelineCard.jsx`

- [ ] **Step 28.1: Create card**

Create `/home/krttpt/crm/frontend/src/components/PipelineCard.jsx`:

```jsx
import { formatRelative } from '@/lib/format';

const TYPE_ICON = {
  papan: '🪦',
  bouquet: '🌹',
  parsel: '🎁',
  cake: '🎂',
  wedding: '💍',
  b2b: '🏢',
  unknown: '❓',
};

const HEALTH_ICON = { vip: '⭐', warm: '🔥', cold: '❄', at_risk: '⚠', new: '' };

export default function PipelineCard({ conv, onClick, draggable, onDragStart }) {
  const phone = conv.real_phone || conv.phone;
  const display = conv.push_name || phone;
  return (
    <div
      role="button"
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      className="bg-white border border-slate-200 rounded-md p-2 text-xs cursor-pointer hover:border-brand-300 hover:shadow-sm transition select-none"
      title={`#${conv.id} · ${phone}`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="font-medium text-slate-800 truncate">{display}</div>
        {HEALTH_ICON[conv.health_band] && <span aria-hidden>{HEALTH_ICON[conv.health_band]}</span>}
      </div>
      <div className="text-[10px] text-slate-500 truncate mt-0.5">{phone}</div>
      <div className="flex items-center gap-1 mt-1 text-[11px]">
        <span aria-hidden>{TYPE_ICON[conv.pipeline_type] || TYPE_ICON.unknown}</span>
        <span className="text-slate-600">{conv.pipeline_type}</span>
      </div>
      {conv.deal_value_idr ? (
        <div className="text-[11px] font-medium text-emerald-700 mt-0.5">
          💰 Rp {Number(conv.deal_value_idr).toLocaleString('id-ID')}
        </div>
      ) : null}
      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
        <span>{conv.last_message_at ? formatRelative(conv.last_message_at) : '—'}</span>
        <span aria-hidden>{conv.manual_stage_override ? '🔒' : '✨'}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 28.2: Build sanity**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -5
```

- [ ] **Step 28.3: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/PipelineCard.jsx && git commit -m "feat(pipeline): PipelineCard component"
```

---

## Task 29: Frontend — PipelineLostModal

**Files:**
- Create: `/home/krttpt/crm/frontend/src/components/PipelineLostModal.jsx`

- [ ] **Step 29.1: Create modal**

Create `/home/krttpt/crm/frontend/src/components/PipelineLostModal.jsx`:

```jsx
import { useState } from 'react';

const REASONS = [
  ['no_reply', 'Customer ghosting / no reply'],
  ['harga_terlalu_tinggi', 'Harga terlalu tinggi'],
  ['kompetitor', 'Pindah ke kompetitor'],
  ['produk_tidak_cocok', 'Produk tidak cocok'],
  ['timing_tidak_pas', 'Timing tidak pas / event lewat'],
  ['cancelled', 'Customer cancel eksplisit'],
  ['refund_complaint', 'Komplain berakhir refund'],
  ['other_with_note', 'Lainnya (isi note)'],
];

export default function PipelineLostModal({ open, onClose, onConfirm }) {
  const [reason, setReason] = useState('no_reply');
  const [note, setNote] = useState('');
  if (!open) return null;
  const needsNote = reason === 'other_with_note';
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-3">
        <h3 className="font-semibold text-slate-800">Mark deal as Lost</h3>
        <div className="space-y-1">
          {REASONS.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name="lost_reason" checked={reason === id} onChange={() => setReason(id)} />
              {label}
            </label>
          ))}
        </div>
        {needsNote && (
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note (wajib)…"
            className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded" />
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-sm px-3 py-1.5 text-slate-600 hover:bg-slate-100 rounded">Batal</button>
          <button
            onClick={() => onConfirm({ reason, note: note.trim() })}
            disabled={needsNote && !note.trim()}
            className="text-sm px-3 py-1.5 rounded bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">
            Konfirmasi Lost
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 29.2: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/PipelineLostModal.jsx && git commit -m "feat(pipeline): PipelineLostModal component"
```

---

## Task 30: Frontend — PipelineForecastPanel

**Files:**
- Create: `/home/krttpt/crm/frontend/src/components/PipelineForecastPanel.jsx`

- [ ] **Step 30.1: Create panel**

Create `/home/krttpt/crm/frontend/src/components/PipelineForecastPanel.jsx`:

```jsx
import useSWR from 'swr';
import { fetcher } from '@/lib/api';

export default function PipelineForecastPanel({ open, onClose, type }) {
  const url = `/api/pipeline/forecast?days=30${type ? `&type=${type}` : ''}`;
  const { data } = useSWR(open ? url : null, fetcher, { refreshInterval: 60_000 });
  if (!open) return null;
  return (
    <aside className="fixed top-0 right-0 bottom-0 w-80 bg-white border-l border-slate-200 shadow-xl z-40 overflow-y-auto" role="dialog" aria-label="Forecast panel">
      <div className="p-4 border-b border-slate-200 flex items-center justify-between">
        <h3 className="font-semibold text-slate-800">📊 Forecast 30d</h3>
        <button onClick={onClose} className="text-slate-500 hover:bg-slate-100 rounded w-8 h-8 inline-flex items-center justify-center">✕</button>
      </div>
      {!data ? (
        <div className="p-4 text-sm text-slate-400">Loading…</div>
      ) : (
        <div className="p-4 space-y-4 text-sm">
          <div>
            <div className="text-xs text-slate-500 uppercase">Expected revenue</div>
            <div className="text-xl font-semibold text-brand-800">Rp {Number(data.expected_revenue).toLocaleString('id-ID')}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 uppercase">Realized 30d (delivered)</div>
            <div className="text-xl font-semibold text-emerald-700">Rp {Number(data.realized_revenue_30d).toLocaleString('id-ID')}</div>
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Conversion rate</div>
            {Object.entries(data.conversion_rates || {}).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-slate-600">{k}</span>
                <span className="font-medium">{Math.round(v * 100)}%</span>
              </div>
            ))}
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Avg time per stage</div>
            {Object.entries(data.avg_time_per_stage_seconds || {}).map(([s, sec]) => (
              <div key={s} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-slate-600">{s}</span>
                <span className="font-medium">{sec < 3600 ? Math.round(sec / 60) + 'm' : Math.round(sec / 3600) + 'j'}</span>
              </div>
            ))}
          </div>

          <div>
            <div className="text-xs text-slate-500 uppercase mb-1">Top Lost reason</div>
            {(data.top_lost_reasons || []).map((r) => (
              <div key={r.lost_reason} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-slate-600">{r.lost_reason}</span>
                <span className="font-medium">{r.n}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 30.2: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/PipelineForecastPanel.jsx && git commit -m "feat(pipeline): PipelineForecastPanel component"
```

---

## Task 31: Frontend — PipelineBoard (desktop kanban)

**Files:**
- Create: `/home/krttpt/crm/frontend/src/components/PipelineBoard.jsx`

- [ ] **Step 31.1: Create board component**

Create `/home/krttpt/crm/frontend/src/components/PipelineBoard.jsx`:

```jsx
import { useState } from 'react';
import { useRouter } from 'next/router';
import PipelineCard from './PipelineCard';
import PipelineLostModal from './PipelineLostModal';
import { api } from '@/lib/api';
import { useToast } from './Toast';

const STAGES = [
  { id: 'baru', label: 'Baru' },
  { id: 'tertarik', label: 'Tertarik' },
  { id: 'form_dikirim', label: 'Form Dikirim' },
  { id: 'order_submitted', label: 'Order Submitted' },
  { id: 'paid', label: 'Paid' },
  { id: 'delivered', label: 'Delivered' },
];

export default function PipelineBoard({ data, mutate, collapseClosed }) {
  const router = useRouter();
  const toast = useToast();
  const [draggedConv, setDraggedConv] = useState(null);
  const [lostFor, setLostFor] = useState(null); // conv being moved to lost

  const visibleStages = collapseClosed
    ? STAGES.filter((s) => s.id !== 'delivered')
    : STAGES;
  const stages = data?.stages || {};

  function sumValue(list) {
    const s = (list || []).reduce((acc, c) => acc + (Number(c.deal_value_idr) || 0), 0);
    return s ? `Rp ${s.toLocaleString('id-ID')}` : '—';
  }

  async function changeStage(convId, toStage, lostExtras) {
    try {
      const body = { stage: toStage, ...(lostExtras || {}) };
      await api(`/api/pipeline/conversations/${convId}/stage`, { method: 'POST', body });
      toast.success(`→ ${toStage}`);
      mutate();
    } catch (e) { toast.error(e.message); mutate(); }
  }

  function onDrop(toStage, e) {
    e.preventDefault();
    if (!draggedConv) return;
    if (draggedConv.pipeline_stage === toStage) { setDraggedConv(null); return; }
    if (toStage === 'lost') {
      setLostFor(draggedConv);
    } else {
      changeStage(draggedConv.id, toStage);
    }
    setDraggedConv(null);
  }

  return (
    <>
      <div className="overflow-x-auto pb-2">
        <div className="flex gap-3 min-w-max">
          {visibleStages.map((s) => {
            const list = stages[s.id] || [];
            return (
              <div
                key={s.id}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(s.id, e)}
                className="w-[230px] shrink-0 bg-slate-50 border border-slate-200 rounded-lg flex flex-col max-h-[calc(100vh-200px)]"
              >
                <div className="px-3 py-2 border-b border-slate-200 sticky top-0 bg-slate-50 z-10">
                  <div className="font-semibold text-slate-800 text-sm">{s.label} ({list.length})</div>
                  <div className="text-[11px] text-slate-500">{sumValue(list)}</div>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {list.map((c) => (
                    <PipelineCard
                      key={c.id} conv={c}
                      draggable
                      onDragStart={() => setDraggedConv(c)}
                      onClick={() => window.open(`/inbox/${c.id}`, '_blank')}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {/* Closed combined column when collapseClosed=true */}
          {collapseClosed && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop('delivered', e)}
              className="w-[200px] shrink-0 bg-teal-50 border border-teal-200 rounded-lg p-2"
            >
              <div className="font-semibold text-teal-800 text-sm">Closed</div>
              <div className="text-[11px] text-teal-600">delivered + lost</div>
              <div className="text-xs text-slate-600 mt-2">
                Delivered: {(stages.delivered || []).length} · Lost: {(stages.lost || []).length}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Lost section (always at bottom) */}
      {!collapseClosed && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => onDrop('lost', e)}
          className="mt-4 bg-rose-50 border border-rose-200 rounded-lg p-3"
        >
          <div className="font-semibold text-rose-800 text-sm mb-2">Lost ({(stages.lost || []).length})</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {(stages.lost || []).slice(0, 20).map((c) => (
              <PipelineCard key={c.id} conv={c} onClick={() => window.open(`/inbox/${c.id}`, '_blank')} />
            ))}
          </div>
        </div>
      )}

      <PipelineLostModal
        open={!!lostFor}
        onClose={() => setLostFor(null)}
        onConfirm={({ reason, note }) => {
          changeStage(lostFor.id, 'lost', { lost_reason: reason, lost_note: note || undefined });
          setLostFor(null);
        }}
      />
    </>
  );
}
```

- [ ] **Step 31.2: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/PipelineBoard.jsx && git commit -m "feat(pipeline): PipelineBoard kanban component (desktop+tablet)"
```

---

## Task 32: Frontend — PipelineMobile (vertical mode)

**Files:**
- Create: `/home/krttpt/crm/frontend/src/components/PipelineMobile.jsx`

- [ ] **Step 32.1: Create mobile component**

Create `/home/krttpt/crm/frontend/src/components/PipelineMobile.jsx`:

```jsx
import { useState } from 'react';
import PipelineCard from './PipelineCard';
import PipelineLostModal from './PipelineLostModal';
import { api } from '@/lib/api';
import { useToast } from './Toast';

const STAGES = [
  { id: 'baru', label: 'Baru' },
  { id: 'tertarik', label: 'Tertarik' },
  { id: 'form_dikirim', label: 'Form Dikirim' },
  { id: 'order_submitted', label: 'Submitted' },
  { id: 'paid', label: 'Paid' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'lost', label: 'Lost' },
];

export default function PipelineMobile({ data, mutate }) {
  const toast = useToast();
  const [activeStage, setActiveStage] = useState('baru');
  const [convForMove, setConvForMove] = useState(null);
  const [lostFor, setLostFor] = useState(null);
  const stages = data?.stages || {};
  const list = stages[activeStage] || [];

  async function moveTo(stage, lostExtras) {
    try {
      await api(`/api/pipeline/conversations/${convForMove.id}/stage`, {
        method: 'POST',
        body: { stage, ...(lostExtras || {}) },
      });
      toast.success(`→ ${stage}`);
      setConvForMove(null);
      mutate();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <>
      <div className="overflow-x-auto border-b border-slate-200 bg-white sticky top-0 z-10">
        <div className="flex gap-1 px-2 py-1">
          {STAGES.map((s) => (
            <button
              key={s.id} onClick={() => setActiveStage(s.id)}
              className={`px-3 py-1.5 text-xs rounded whitespace-nowrap ${
                activeStage === s.id ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {s.label} ({(stages[s.id] || []).length})
            </button>
          ))}
        </div>
      </div>

      <div className="p-3 space-y-2">
        {list.length === 0 && <div className="text-center text-sm text-slate-400 py-6">Tidak ada deal di stage ini.</div>}
        {list.map((c) => (
          <div key={c.id} className="bg-white border border-slate-200 rounded-md p-3 flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0" onClick={() => window.open(`/inbox/${c.id}`, '_blank')}>
              <PipelineCard conv={c} onClick={() => window.open(`/inbox/${c.id}`, '_blank')} />
            </div>
            <button
              onClick={() => setConvForMove(c)}
              className="shrink-0 text-xs px-2 py-1 rounded text-slate-600 hover:bg-slate-100"
            >⋯</button>
          </div>
        ))}
      </div>

      {convForMove && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center" onClick={() => setConvForMove(null)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-lg sm:rounded-lg p-4 space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="font-semibold text-slate-800 text-sm">Pindah ke stage…</div>
            {STAGES.filter((s) => s.id !== activeStage).map((s) => (
              <button
                key={s.id}
                onClick={() => s.id === 'lost' ? setLostFor(convForMove) : moveTo(s.id)}
                className="w-full text-left text-sm px-3 py-2 rounded hover:bg-slate-50 border border-slate-100"
              >{s.label}</button>
            ))}
            <button onClick={() => setConvForMove(null)} className="w-full text-center text-sm py-2 text-slate-500">Batal</button>
          </div>
        </div>
      )}

      <PipelineLostModal
        open={!!lostFor}
        onClose={() => { setLostFor(null); setConvForMove(null); }}
        onConfirm={({ reason, note }) => {
          moveTo('lost', { lost_reason: reason, lost_note: note || undefined });
          setLostFor(null);
        }}
      />
    </>
  );
}
```

- [ ] **Step 32.2: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/components/PipelineMobile.jsx && git commit -m "feat(pipeline): PipelineMobile vertical mode component"
```

---

## Task 33: Frontend — `/pipeline` page wiring

**Files:**
- Create: `/home/krttpt/crm/frontend/src/pages/pipeline.js`

- [ ] **Step 33.1: Create page**

Create `/home/krttpt/crm/frontend/src/pages/pipeline.js`:

```jsx
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import PipelineBoard from '@/components/PipelineBoard';
import PipelineMobile from '@/components/PipelineMobile';
import PipelineForecastPanel from '@/components/PipelineForecastPanel';
import { fetcher } from '@/lib/api';

const TYPES = ['', 'papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b', 'unknown'];

function useViewport() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => {
    function onResize() { setW(window.innerWidth); }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

export default function PipelinePage() {
  const [type, setType] = useState('');
  const [claimedBy, setClaimedBy] = useState('');
  const [forecastOpen, setForecastOpen] = useState(false);
  const w = useViewport();
  const isMobile = w < 768;
  const collapseClosed = w >= 768 && w < 1024;

  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (claimedBy) params.set('claimed_by', claimedBy);
  const url = `/api/pipeline/board${params.toString() ? '?' + params.toString() : ''}`;

  const { data, mutate } = useSWR(url, fetcher, { refreshInterval: 30_000 });

  return (
    <Layout title="Pipeline — Tiara">
      <div className="px-3 sm:px-6 py-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold text-slate-800">Pipeline</h1>
          <select value={type} onChange={(e) => setType(e.target.value)}
            className="text-xs px-2 py-1 border border-slate-200 rounded">
            {TYPES.map((t) => <option key={t} value={t}>{t || 'All types'}</option>)}
          </select>
          <select value={claimedBy} onChange={(e) => setClaimedBy(e.target.value)}
            className="text-xs px-2 py-1 border border-slate-200 rounded">
            <option value="">All operators</option>
            <option value="me">Me only</option>
          </select>
          <button onClick={() => setForecastOpen(true)}
            className="ml-auto text-xs px-3 py-1.5 rounded bg-brand-50 text-brand-700 border border-brand-200 hover:bg-brand-100">
            📊 Forecast
          </button>
        </div>

        {isMobile
          ? <PipelineMobile data={data} mutate={mutate} />
          : <PipelineBoard data={data} mutate={mutate} collapseClosed={collapseClosed} />}
      </div>

      <PipelineForecastPanel open={forecastOpen} onClose={() => setForecastOpen(false)} type={type} />
    </Layout>
  );
}
```

- [ ] **Step 33.2: Build + restart frontend**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -8
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
sleep 2
curl -sf -o /dev/null -w "/pipeline HTTP %{http_code}\n" http://localhost:4013/pipeline
```

Expected: HTTP 200.

- [ ] **Step 33.3: Commit**

```bash
cd /home/krttpt/crm && git add frontend/src/pages/pipeline.js && git commit -m "feat(pipeline): /pipeline page wiring (responsive)"
```

---

## Task 34: End-to-end smoke test

- [ ] **Step 34.1: Restart everything fresh**

```bash
pm2 restart crm-pilot-backend --update-env 2>&1 | grep online | head -1
pm2 restart crm-pilot-frontend --update-env 2>&1 | grep online | head -1
sleep 3
```

- [ ] **Step 34.2: Verify backend logs no errors**

```bash
pm2 logs crm-pilot-backend --lines 15 --nostream --err 2>&1 | tail -15
```

Expected: no recent error entries from pipeline code.

- [ ] **Step 34.3: API smoke**

```bash
# Auth-required, expect 401 without cookie
curl -s -o /dev/null -w "board %{http_code} forecast %{http_code}\n" \
  http://localhost:3009/api/pipeline/board \
  http://localhost:3009/api/pipeline/forecast
```

Expected: `board 401 forecast 401` (auth working).

- [ ] **Step 34.4: Manual UAT — open https://salesai.prestisa.net/pipeline in browser**

Login as admin. Verify:
- Page loads with kanban columns
- Each column shows count + sum value
- At least some cards visible (from backfill)
- Drag a card from one column to another → toast "→ stage"
- Drag a card to Lost area → modal opens → pick reason → confirm → card moves
- Open `/inbox/<id>` for a moved card → header shows new stage badge
- Click "📊 Forecast" → side panel opens with revenue numbers

If any step fails, debug + fix in a new task.

- [ ] **Step 34.5: SQL sanity**

```bash
eval "$(grep -E '^PG_(HOST|PORT|DATABASE|USER|PASSWORD)=' /home/krttpt/crm/.env | sed 's/=\(.*\)$/=\"\1\"/')" && \
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" -c \
"SELECT pipeline_stage, COUNT(*), SUM(deal_value_idr)::bigint AS total_value FROM crm_conversations GROUP BY pipeline_stage ORDER BY pipeline_stage"
```

Sanity check distribution makes sense.

```bash
PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE" -c \
"SELECT to_stage, source, COUNT(*) FROM crm_pipeline_events WHERE created_at > now() - interval '1 hour' GROUP BY to_stage, source"
```

Expected: recent events from manual:operator (your test drags) + maybe auto sources.

- [ ] **Step 34.6: Final commit (UAT documentation)**

```bash
cd /home/krttpt/crm && git commit --allow-empty -m "chore(pipeline): UAT smoke complete"
```

---

## Self-Review Checklist (run mentally before marking plan done)

- ✅ All 12 spec sections covered? (Goals, Scope, Data Model, Auto-transition, UI, API, Backfill, Edge Cases, Testing, Telemetry, Risks, Implementation outline) — each touched.
- ✅ All 7 endpoints in spec section 6 implemented? Yes (board, stage, type, value, revert-stage, forecast, events) — Task 6.
- ✅ All hooks in spec section 12 wired? Tasks 7-17 cover webhook/aiAgent/aiTools/funnel/deliveryComms/handover/spam/claim/tag/recurring/snooze.
- ✅ Backfill script with all 8 decision branches? Yes — Task 19.
- ✅ Cron entry added? Yes — Task 21.
- ✅ Frontend kanban + mobile + forecast panel + integrations? Tasks 28-33.
- ✅ Tests for compute logic? Yes — Tasks 3, 4, 5.

Plan covers spec end-to-end. Ready for execution.
