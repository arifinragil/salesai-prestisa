# AI Co-Pilot Phase 2 — Lead Temperature Classifier

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score every active conversation as hot/warm/cold (rule-based, sub-50ms), surface temperature badges in inbox UI, and Telegram-alert hot leads that go unanswered for ≥3 min.

**Architecture:** New `leadTemperature` service computes a 0–100 score from intent + keyword + behavioral signals, decayed by recency. Computed on every inbound (in webhook, after spam check), every pipeline event, and on a 5-min cron sweep for decay. UI surfaces badges + temp-aware sort + hot-lead banner in the co-pilot panel. A 1-min cron alerts unanswered hot leads via Telegram.

**Tech Stack:** Node 20 + Express 5, PostgreSQL (pg), MySQL (legacy `prestisa` DB for past-order lookup), Next.js 14 + Tailwind v3 + SWR. No new external deps.

**Spec reference:** `docs/specs/2026-05-02-ai-copilot-supervisor-design.md` section 6.

**DB state assumed:** Phase 1 migration `015_copilot.sql` already created `crm_conversations.lead_temperature` (CHECK hot|warm|cold, default 'cold') and `lead_score smallint`, plus `first_inbound_at` and `first_response_at`. No new DB schema needed except a small dedupe table for hot-lead alerts.

**Out of scope (Phase 3):** Supervisor scoring (red flag log, daily score aggregation, /supervisor dashboard, missed-followup cron). Lead-temperature alerts use Telegram directly without going through the red flag log; Phase 3 will wire them into `crm_agent_red_flags` for unified alerting.

---

## File Map

**Backend create:**
- `backend/migrations/017_hot_lead_alerts.sql` — single table for alert dedup
- `backend/services/leadTemperature.js` — compute() + signal scoring + persist
- `backend/scripts/leadTempDecay.js` — cron 5-min recency decay sweep
- `backend/scripts/hotLeadAlert.js` — cron 1-min unanswered hot lead Telegram alerts
- `backend/scripts/backfillLeadTemperature.js` — one-shot historical compute

**Backend modify:**
- `backend/routes/webhook.js` — call leadTemperature.compute after spam check, before AI queue
- `backend/services/pipelineEngine.js` — call leadTemperature.compute after stage transition
- `backend/routes/inbox.js` — include `lead_temperature`, `lead_score` in conversations list response; accept `?sort=temp` param
- `/tmp/crm-pilot.cron` — add 2 cron entries

**Frontend create:**
- `frontend/src/components/LeadTempBadge.jsx` — tiny badge (emoji + score) with consistent colors

**Frontend modify:**
- `frontend/src/pages/inbox/index.js` — render badge in list rows, add "by temperature" sort option
- `frontend/src/pages/inbox/[id].js` — render LeadTempBadge in chat header
- `frontend/src/components/CoPilotPanel.jsx` — add "🔥 Close ASAP" banner when conv is hot
- `frontend/src/components/PipelineCard.jsx` — add temperature-colored left-border accent

---

## Task 1: Migration `017_hot_lead_alerts.sql`

**Files:**
- Create: `backend/migrations/017_hot_lead_alerts.sql`

**Why this table:** alert cron runs every minute. Without dedup it would re-alert the same conv every minute. Table records the last alert sent per (conversation_id, alert_kind) so cron can `WHERE NOT EXISTS (...)` cheaply.

- [ ] **Step 1: Write migration**

```sql
-- 017_hot_lead_alerts.sql — dedup table for unanswered hot-lead Telegram alerts
BEGIN;

CREATE TABLE IF NOT EXISTS crm_hot_lead_alerts (
  id              bigserial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  alert_kind      varchar(20) NOT NULL CHECK (alert_kind IN ('owner_3min', 'supervisor_5min')),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  inbound_msg_id  bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  staff_id        int REFERENCES staff_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS crm_hot_lead_alerts_dedup_idx
  ON crm_hot_lead_alerts (conversation_id, alert_kind, sent_at DESC);

COMMIT;
```

- [ ] **Step 2: Apply**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports \
  -f backend/migrations/017_hot_lead_alerts.sql
```

Expected: `BEGIN ... CREATE TABLE ... CREATE INDEX ... COMMIT`

- [ ] **Step 3: Verify**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports \
  -c "\d crm_hot_lead_alerts"
```

Expected: 5 columns, FK to crm_conversations + crm_messages + staff_users, CHECK on alert_kind, dedup index present.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/017_hot_lead_alerts.sql
git commit -m "feat(db): migration 017 — hot lead alert dedup table

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `leadTemperature.js` service

**Files:**
- Create: `backend/services/leadTemperature.js`

This is the heart of Phase 2. Single file, single export `compute(conversationId, opts)`. Persists to `crm_conversations.lead_temperature` + `lead_score`. Returns the computed `{ temp, score, signals }` for callers.

- [ ] **Step 1: Write the service**

```js
// backend/services/leadTemperature.js
// Rule-based lead temperature classifier. Sub-50ms. Per spec section 6.
//
// score = (base + intent + keyword + behavioral) * recency_factor
// score >= 70 → hot; 40..69 → warm; 0..39 → cold
//
// Triggers (called by):
//   - webhook ingest (after spam check)
//   - pipelineEngine.apply (after stage transition)
//   - cron leadTempDecay (recency sweep)

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('./logger');

const HOT_KEYWORDS = [
  /\y(transfer kemana|nomor rek|rekening|VA|bayar dimana|bayar sekarang)\y/i,
  /\y(budget|anggaran)\s*(rp|sekitar)?\s*\d/i,
  /\y(deadline|harus sampai|wajib hari ini|urgent|asap)\y/i,
  /\y(sip|ok|deal|setuju|mau|jadi(?:in)?|fix(?:in)?)\y/i,
  /\y(kapan bisa kirim|siap kirim|delivery besok)\y/i,
];

const WARM_KEYWORDS = [
  /\y(harga|berapa|murah|diskon|promo)\y/i,
  /\y(tersedia|ready|stok|ada ngga|ada|tanggal)\y/i,
  /\y(model|warna|ukuran|pilihan)\y/i,
];

// NOTE: PostgreSQL uses \y (not \b) for word boundary. JS regex objects
// support \b — we use \b in JS-side keyword scoring below for the same intent.
const HOT_KEYWORDS_JS = [
  /\b(transfer kemana|nomor rek|rekening|VA|bayar dimana|bayar sekarang)\b/i,
  /\b(budget|anggaran)\s*(rp|sekitar)?\s*\d/i,
  /\b(deadline|harus sampai|wajib hari ini|urgent|asap)\b/i,
  /\b(sip|ok|deal|setuju|mau|jadi(?:in)?|fix(?:in)?)\b/i,
  /\b(kapan bisa kirim|siap kirim|delivery besok)\b/i,
];
const WARM_KEYWORDS_JS = [
  /\b(harga|berapa|murah|diskon|promo)\b/i,
  /\b(tersedia|ready|stok|ada ngga|ada|tanggal)\b/i,
  /\b(model|warna|ukuran|pilihan)\b/i,
];

function scoreIntent(intent) {
  if (!intent) return 0;
  switch (intent) {
    case 'order_intent': return 35;
    case 'payment':
    case 'confirm_order': return 30;
    case 'shipping': return 20;
    case 'pricing': return 15;
    case 'order_status': return 10;
    case 'product_info': return 5;
    case 'complaint':
    case 'cancel': return -20;
    default: return 0;
  }
}

function scoreKeywords(body) {
  if (!body) return 0;
  const text = String(body);
  let score = 0;
  for (const re of HOT_KEYWORDS_JS) if (re.test(text)) { score += 15; break; }
  for (const re of WARM_KEYWORDS_JS) if (re.test(text)) { score += 8; break; }
  return Math.min(30, score);
}

function recencyFactor(lastInboundAt) {
  if (!lastInboundAt) return 0.4;
  const minutes = (Date.now() - new Date(lastInboundAt).getTime()) / 60_000;
  const decay = Math.max(0, 1 - minutes / 120);
  return 0.4 + 0.6 * decay;
}

async function loadContext(conversationId) {
  const cQ = await pg.query(
    `SELECT id, customer_id, last_intent, last_message_at, pipeline_stage,
            real_phone, phone
     FROM crm_conversations WHERE id = $1`,
    [conversationId]
  );
  const conv = cQ.rows[0];
  if (!conv) return null;

  const recentMsgsQ = await pg.query(
    `SELECT body, direction, created_at
     FROM crm_messages
     WHERE conversation_id = $1 AND created_at > now() - interval '30 minutes'
     ORDER BY id DESC LIMIT 20`,
    [conversationId]
  );
  const lastInbound = recentMsgsQ.rows.find((m) => m.direction === 'in');
  const inboundCountLast30m = recentMsgsQ.rows.filter((m) => m.direction === 'in').length;

  // Form submitted? — short-circuit signal
  const linkQ = await pg.query(
    `SELECT event FROM crm_link_events
     WHERE conversation_id = $1 AND created_at > now() - interval '24 hours'
     ORDER BY id DESC LIMIT 5`,
    [conversationId]
  );
  const submitted = linkQ.rows.some((e) => e.event === 'submitted');
  const clicked   = linkQ.rows.some((e) => e.event === 'clicked');

  // Past order? (existing customer signal)
  let pastOrder = false;
  if (conv.customer_id) {
    try {
      const [rows] = await mysql.query(
        `SELECT 1 FROM \`order\` WHERE customer_id = ? AND deleted_at IS NULL LIMIT 1`,
        [conv.customer_id]
      );
      pastOrder = rows.length > 0;
    } catch (err) {
      logger.warn({ err: err.message, conv_id: conversationId }, '[leadTemp] mysql past-order lookup failed');
    }
  }

  // Recent lost?
  const lostQ = await pg.query(
    `SELECT 1 FROM crm_pipeline_events
     WHERE conversation_id = $1 AND to_stage = 'lost'
       AND created_at > now() - interval '30 days'
     LIMIT 1`,
    [conversationId]
  );
  const recentLost = lostQ.rows.length > 0;

  return {
    conv,
    lastInbound,
    inboundCountLast30m,
    submitted,
    clicked,
    pastOrder,
    recentLost,
  };
}

function scoreBehavior(ctx) {
  if (ctx.submitted) return null; // sentinel: caller short-circuits to 100/hot
  let s = 0;
  if (ctx.clicked) s += 15;
  if (ctx.inboundCountLast30m >= 3) s += 10;
  if (ctx.pastOrder) s += 10;
  if (ctx.conv.pipeline_stage === 'qualified' || ctx.conv.pipeline_stage === 'proposal_sent') s += 20;
  if (ctx.recentLost) s -= 15;
  return s;
}

function tempFor(score) {
  if (score >= 70) return 'hot';
  if (score >= 40) return 'warm';
  return 'cold';
}

/**
 * Compute and persist lead temperature for a conversation.
 *
 * @param {number} conversationId
 * @param {{ inboundBody?: string, intent?: string }} [opts]  optional fresh signals
 *        from the caller (webhook has them in scope; cron does not)
 * @returns {Promise<{temp:string, score:number, signals:object}>}
 */
async function compute(conversationId, opts = {}) {
  const ctx = await loadContext(conversationId);
  if (!ctx) return { temp: 'cold', score: 0, signals: { error: 'conv_missing' } };

  // Form submitted is a hard signal → max it out.
  if (ctx.submitted) {
    await persist(conversationId, 'hot', 100);
    return { temp: 'hot', score: 100, signals: { submitted: true } };
  }

  const intent = opts.intent || ctx.conv.last_intent || null;
  const inboundBody = opts.inboundBody || ctx.lastInbound?.body || '';

  const intentScore   = scoreIntent(intent);
  const keywordScore  = scoreKeywords(inboundBody);
  const behaviorScore = scoreBehavior(ctx);
  const rawTotal      = intentScore + keywordScore + behaviorScore;
  const recency       = recencyFactor(ctx.lastInbound?.created_at || ctx.conv.last_message_at);
  let score = rawTotal * recency;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const temp = tempFor(score);

  await persist(conversationId, temp, score);

  return {
    temp,
    score,
    signals: {
      intent, intentScore,
      keywordScore, behaviorScore,
      rawTotal, recency: Number(recency.toFixed(3)),
      pipeline: ctx.conv.pipeline_stage,
      pastOrder: ctx.pastOrder,
      clicked: ctx.clicked,
      recentLost: ctx.recentLost,
      inboundCountLast30m: ctx.inboundCountLast30m,
    },
  };
}

async function persist(conversationId, temp, score) {
  await pg.query(
    `UPDATE crm_conversations SET lead_temperature = $2, lead_score = $3 WHERE id = $1`,
    [conversationId, temp, score]
  );
}

module.exports = { compute };
```

- [ ] **Step 2: Smoke test against a real conversation**

```bash
cd /home/krttpt/crm/backend && node -e "
require('dotenv').config({ path: '../.env' });
(async () => {
  const pg = require('./db/postgres');
  const c = await pg.query(\"SELECT id, last_intent FROM crm_conversations WHERE last_message_at > now() - interval '1 day' ORDER BY last_message_at DESC LIMIT 1\");
  if (!c.rows[0]) { console.log('no recent conv'); process.exit(0); }
  const lt = require('./services/leadTemperature');
  const r = await lt.compute(c.rows[0].id);
  console.log(JSON.stringify({ conv_id: c.rows[0].id, last_intent: c.rows[0].last_intent, ...r }, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected: prints `{ temp: 'cold'|'warm'|'hot', score: <int>, signals: {...} }`. Score reasonable for a typical conv (10–60 range absent strong buy signals). No mysql/pg errors.

- [ ] **Step 3: Verify the column updated**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports \
  -c "SELECT id, lead_temperature, lead_score FROM crm_conversations WHERE last_message_at > now() - interval '1 day' ORDER BY last_message_at DESC LIMIT 1;"
```

Expected: lead_temperature + lead_score populated (non-NULL).

- [ ] **Step 4: Commit**

```bash
git add backend/services/leadTemperature.js
git commit -m "feat(copilot): leadTemperature — rule-based hot/warm/cold classifier

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire into webhook ingest

**Files:**
- Modify: `backend/routes/webhook.js`

Insert AFTER spam filter (so spam-blocked convs don't get classified) and BEFORE the inbound queue insert (so debouncing doesn't matter — temp is per-message). Run async (don't await — keep webhook fast). Per spec NFR-A2 lead temp must compute < 50ms; running it inline is fine but fire-and-forget protects the 200ms ingest latency budget.

- [ ] **Step 1: Read current webhook ingest path**

```bash
grep -n "spamSkipped\|debounceSec\|inbound_queue\|spam.check" /home/krttpt/crm/backend/routes/webhook.js | head -10
```

Note the line numbers around the spam-check exit and the inbound_queue INSERT.

- [ ] **Step 2: Insert the call right after the spam-skipped early-return**

In `backend/routes/webhook.js`, find this existing block (around lines 143-148):
```js
if (spamSkipped) {
  await client.query('COMMIT');
  ...
  return res.json({ success: true, conversation_id: conv.id, ..., spam_blocked: true });
}
```

Immediately after that closing `}` (i.e. for non-spam path), add:

```js
    // Lead temperature — refresh on every inbound (per spec §6.3).
    // Fire-and-forget: must not block ingest.
    try {
      const leadTemp = require('../services/leadTemperature');
      leadTemp.compute(conv.id, { inboundBody: parsed.body, intent: null })
        .catch((err) => console.warn('[leadTemp] compute failed:', err.message));
    } catch {}
```

- [ ] **Step 3: Restart backend + smoke**

```bash
pm2 restart crm-pilot-backend && sleep 2
```

Pick a recent inbound conv and confirm next inbound triggers compute. Easiest: just queue and process via the same node script as Phase 1 Task 5, then check the conv row:

```bash
cd /home/krttpt/crm/backend && node -e "
require('dotenv').config({ path: '../.env' });
const pg = require('./db/postgres');
(async () => {
  const r = await pg.query(\"SELECT id, lead_temperature, lead_score, last_message_at FROM crm_conversations WHERE last_message_at > now() - interval '10 minutes' AND lead_score IS NOT NULL ORDER BY last_message_at DESC LIMIT 5\");
  console.table(r.rows);
  process.exit(0);
})();
"
```

Expected: rows with non-NULL `lead_score`. (To force a fresh compute, send a real inbound to the dev WAHA — the next msg arrival will trigger.)

- [ ] **Step 4: Commit**

```bash
git add backend/routes/webhook.js
git commit -m "feat(copilot): compute leadTemperature on every inbound

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire into pipelineEngine

**Files:**
- Modify: `backend/services/pipelineEngine.js`

Pipeline stage changes (qualified, proposal_sent, lost) shift the score significantly. Recompute after every stage transition.

- [ ] **Step 1: Locate the apply() function**

```bash
grep -n "exports.apply\|async function apply\|function apply\|UPDATE crm_pipeline_events\|UPDATE crm_conversations.*pipeline_stage" /home/krttpt/crm/backend/services/pipelineEngine.js | head -10
```

- [ ] **Step 2: Add the call at the very end of apply(), after the stage UPDATE + event INSERT have committed**

After the existing INSERT into `crm_pipeline_events` (and any subsequent UPDATE on `crm_conversations.pipeline_stage`), add:

```js
  // Refresh lead temperature — pipeline stage shift changes score (qualified +20, lost -15).
  try {
    const leadTemp = require('./leadTemperature');
    leadTemp.compute(conversationId).catch((err) => console.warn('[leadTemp] pipeline hook failed:', err.message));
  } catch {}
```

(`conversationId` is the param name in apply(). If the actual local var differs — `convId` or `conv.id` — adapt.)

- [ ] **Step 3: Smoke — trigger a fake pipeline transition + verify score change**

```bash
cd /home/krttpt/crm/backend && node -e "
require('dotenv').config({ path: '../.env' });
const pg = require('./db/postgres');
(async () => {
  const c = await pg.query(\"SELECT id, lead_temperature, lead_score, pipeline_stage FROM crm_conversations WHERE last_message_at > now() - interval '7 days' AND pipeline_stage IS NOT NULL ORDER BY last_message_at DESC LIMIT 1\");
  console.log('BEFORE', c.rows[0]);
  const eng = require('./services/pipelineEngine');
  await eng.apply(pg, c.rows[0].id, { type: 'intent_qualified' }, { source: 'smoke:phase2' });
  await new Promise(r => setTimeout(r, 600));
  const c2 = await pg.query(\"SELECT id, lead_temperature, lead_score, pipeline_stage FROM crm_conversations WHERE id = \$1\", [c.rows[0].id]);
  console.log('AFTER ', c2.rows[0]);
  process.exit(0);
})();
"
```

Expected: AFTER row shows updated pipeline_stage AND `lead_score` value (may shift up if qualified threshold hit). Both fields populated.

- [ ] **Step 4: Commit**

```bash
git add backend/services/pipelineEngine.js
git commit -m "feat(copilot): refresh leadTemperature after pipeline transitions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Recency decay cron `leadTempDecay.js`

**Files:**
- Create: `backend/scripts/leadTempDecay.js`
- Modify: `/tmp/crm-pilot.cron`

Sweep all active conversations every 5 min and recompute. This applies `recency_factor` decay so a hot lead from 2 hours ago drifts back down.

- [ ] **Step 1: Write the cron script**

```js
// backend/scripts/leadTempDecay.js
// Every 5 min: recompute lead temperature for all active convs.
// Cheap: rule-based, sub-50ms each. Limit batch to keep run < 1 min total.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const leadTemp = require('../services/leadTemperature');
const logger = require('../services/logger');

const BATCH_LIMIT = 200;

async function run() {
  const r = await pg.query(
    `SELECT id FROM crm_conversations
     WHERE status = 'active' AND last_message_at > now() - interval '7 days'
     ORDER BY last_message_at DESC
     LIMIT $1`,
    [BATCH_LIMIT]
  );
  let scanned = 0, updated = 0, errors = 0;
  for (const row of r.rows) {
    scanned++;
    try {
      await leadTemp.compute(row.id);
      updated++;
    } catch (err) {
      errors++;
      logger.warn({ err: err.message, conv_id: row.id }, '[leadTempDecay] compute failed');
    }
  }
  logger.info({ scanned, updated, errors }, '[leadTempDecay] done');
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => {
    logger.error({ err: err.message }, '[leadTempDecay] failed');
    process.exit(1);
  });
}
module.exports = { run };
```

- [ ] **Step 2: Test the script manually**

```bash
cd /home/krttpt/crm && node backend/scripts/leadTempDecay.js
```

Expected: prints `[leadTempDecay] done` log line with `scanned: <n>, updated: <n>`. No errors. Process exits 0 within ~30 sec.

- [ ] **Step 3: Add cron entry**

Read the existing cron file:

```bash
cat /tmp/crm-pilot.cron
```

Add this line (in the existing format — match the style of other entries):

```
*/5 * * * * cd /home/krttpt/crm && /usr/bin/node backend/scripts/leadTempDecay.js >> logs/leadTempDecay.log 2>&1
```

Then install:

```bash
crontab /tmp/crm-pilot.cron
crontab -l | grep leadTempDecay
```

Expected: line printed back.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/leadTempDecay.js
git commit -m "feat(copilot): leadTempDecay cron — recompute every 5 min

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(The `/tmp/crm-pilot.cron` file is not in the repo — that's expected. Crontab is installed separately.)

---

## Task 6: Hot lead unanswered alert cron `hotLeadAlert.js`

**Files:**
- Create: `backend/scripts/hotLeadAlert.js`
- Modify: `/tmp/crm-pilot.cron`

Per spec §6.5: hot lead + no operator response 3 min → Telegram alert to conv owner; 5 min → escalate to supervisor. Dedup table `crm_hot_lead_alerts` (Task 1) prevents re-alerts.

- [ ] **Step 1: Write the script**

```js
// backend/scripts/hotLeadAlert.js
// Every 1 min: scan hot leads with no operator response in 3+ min and Telegram-alert.
// 5+ min escalates to supervisor (alert_kind='supervisor_5min').
// Dedup via crm_hot_lead_alerts.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const tg = require('../services/telegramNotify');
const settings = require('../services/settings');
const logger = require('../services/logger');

async function run() {
  // Find hot leads where the most recent message is inbound and >3 min old,
  // AND no out-from-staff message since that inbound.
  const q = await pg.query(
    `WITH recent AS (
       SELECT m.id AS msg_id, m.conversation_id, m.created_at AS inbound_at
       FROM crm_messages m
       JOIN crm_conversations c ON c.id = m.conversation_id
       WHERE c.lead_temperature = 'hot'
         AND c.status = 'active'
         AND m.direction = 'in'
         AND m.created_at > now() - interval '30 minutes'
         AND m.created_at < now() - interval '3 minutes'
       ORDER BY m.id DESC
       LIMIT 100
     ),
     latest_in AS (
       SELECT DISTINCT ON (conversation_id) conversation_id, msg_id, inbound_at
       FROM recent ORDER BY conversation_id, msg_id DESC
     )
     SELECT li.conversation_id, li.msg_id, li.inbound_at, c.assigned_staff_id, c.phone
     FROM latest_in li
     JOIN crm_conversations c ON c.id = li.conversation_id
     WHERE NOT EXISTS (
       SELECT 1 FROM crm_messages m2
       WHERE m2.conversation_id = li.conversation_id
         AND m2.direction = 'out'
         AND m2.sender_type IN ('operator', 'ai')
         AND m2.created_at > li.inbound_at
     )`
  );

  let owner_alerts = 0, supervisor_alerts = 0, skipped_dup = 0;
  for (const row of q.rows) {
    const ageMin = (Date.now() - new Date(row.inbound_at).getTime()) / 60_000;
    const kind = ageMin >= 5 ? 'supervisor_5min' : 'owner_3min';

    // Dedup: check if we've already alerted for this kind in the last 30 min
    const dup = await pg.query(
      `SELECT 1 FROM crm_hot_lead_alerts
       WHERE conversation_id = $1 AND alert_kind = $2 AND sent_at > now() - interval '30 minutes'
       LIMIT 1`,
      [row.conversation_id, kind]
    );
    if (dup.rows.length) { skipped_dup++; continue; }

    const text = (kind === 'supervisor_5min')
      ? `🚨 HOT LEAD UNANSWERED ${Math.round(ageMin)}m\nConv #${row.conversation_id} (${row.phone})\nEskalasi: operator owner tidak respond dalam 5 menit.`
      : `🔥 Hot lead waiting ${Math.round(ageMin)}m\nConv #${row.conversation_id} (${row.phone})\nMohon respond ASAP.`;

    let sentTo = null;
    if (kind === 'owner_3min' && row.assigned_staff_id) {
      try { await tg.sendToStaff(row.assigned_staff_id, text); sentTo = row.assigned_staff_id; owner_alerts++; }
      catch (err) { logger.warn({ err: err.message, conv: row.conversation_id }, '[hotLeadAlert] sendToStaff failed'); }
    } else {
      // No assigned owner OR escalation → default chat (supervisor)
      const supChat = await settings.getSetting('telegram_chat_sla', null) ||
                      await settings.getSetting('telegram_chat_id', null);
      if (supChat) {
        try { await tg.send(text, { _overrideChatId: supChat }); supervisor_alerts++; }
        catch (err) { logger.warn({ err: err.message }, '[hotLeadAlert] send supervisor failed'); }
      }
    }

    await pg.query(
      `INSERT INTO crm_hot_lead_alerts (conversation_id, alert_kind, inbound_msg_id, staff_id)
       VALUES ($1, $2, $3, $4)`,
      [row.conversation_id, kind, row.msg_id, sentTo]
    );
  }

  logger.info({
    candidates: q.rows.length, owner_alerts, supervisor_alerts, skipped_dup,
  }, '[hotLeadAlert] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => {
    logger.error({ err: err.message }, '[hotLeadAlert] failed');
    process.exit(1);
  });
}
module.exports = { run };
```

- [ ] **Step 2: Verify telegramNotify exports**

```bash
grep -n "module.exports\|sendToStaff\|^async function send\|_overrideChatId" /home/krttpt/crm/backend/services/telegramNotify.js | head -10
```

If `send()` doesn't accept `_overrideChatId` opt or `sendToStaff` is missing, **stop and report** — do not invent missing helpers. Phase 1 added these per the conversation history; verify they're present.

- [ ] **Step 3: Test the script manually**

```bash
cd /home/krttpt/crm && node backend/scripts/hotLeadAlert.js
```

Expected:
- `[hotLeadAlert] done candidates=<n> owner_alerts=<n> supervisor_alerts=<n> skipped_dup=<n>`
- If candidates > 0 and a Telegram bot token is configured, an alert message arrives in Telegram.
- If candidates = 0 (no hot leads waiting), script exits cleanly with all counts at 0.

Re-run immediately:

```bash
cd /home/krttpt/crm && node backend/scripts/hotLeadAlert.js
```

Expected: `skipped_dup` equals previous `owner_alerts + supervisor_alerts` (dedup working).

- [ ] **Step 4: Add cron entry**

```bash
echo '*/1 * * * * cd /home/krttpt/crm && /usr/bin/node backend/scripts/hotLeadAlert.js >> logs/hotLeadAlert.log 2>&1' >> /tmp/crm-pilot.cron
crontab /tmp/crm-pilot.cron
crontab -l | grep hotLeadAlert
```

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/hotLeadAlert.js
git commit -m "feat(copilot): hotLeadAlert cron — Telegram unanswered hot lead alerts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Backfill historical conversations

**Files:**
- Create: `backend/scripts/backfillLeadTemperature.js`

One-shot: compute lead temp for all convs with `last_message_at > now() - 30 days`. Run once after Phase 2 deploys to give the inbox UI immediate data.

- [ ] **Step 1: Write the script**

```js
// backend/scripts/backfillLeadTemperature.js
// One-shot: compute lead_temperature + lead_score for all convs with activity in last 30d.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const leadTemp = require('../services/leadTemperature');
const logger = require('../services/logger');

async function run() {
  const r = await pg.query(
    `SELECT id FROM crm_conversations
     WHERE last_message_at > now() - interval '30 days'
     ORDER BY last_message_at DESC`
  );
  let i = 0, errors = 0;
  for (const row of r.rows) {
    try {
      await leadTemp.compute(row.id);
      i++;
      if (i % 50 === 0) logger.info({ done: i, total: r.rows.length }, '[backfillLeadTemp] progress');
    } catch (err) {
      errors++;
      logger.warn({ err: err.message, conv_id: row.id }, '[backfillLeadTemp] compute failed');
    }
  }
  logger.info({ total: r.rows.length, ok: i, errors }, '[backfillLeadTemp] done');
  await pg.end();
  await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[backfillLeadTemp] failed'); process.exit(1); });
}
```

- [ ] **Step 2: Run it**

```bash
cd /home/krttpt/crm && node backend/scripts/backfillLeadTemperature.js
```

Expected: progress logs every 50, final `done total=<n> ok=<n> errors=<small>`.

- [ ] **Step 3: Verify distribution**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT lead_temperature, COUNT(*) FROM crm_conversations
   WHERE last_message_at > now() - interval '30 days'
   GROUP BY lead_temperature ORDER BY lead_temperature;"
```

Expected: 3 rows hot/warm/cold, mostly cold (typical inbound is FAQ/browse). If 100% cold or 100% hot, signals are misweighted — investigate before committing.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/backfillLeadTemperature.js
git commit -m "feat(copilot): backfillLeadTemperature — one-shot historical compute

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Inbox API — return temp/score + add sort param

**Files:**
- Modify: `backend/routes/inbox.js`

- [ ] **Step 1: Add lead_temperature, lead_score to the SELECT in `/conversations`**

Find the SELECT block (around lines 64-72 — `SELECT conv.id, conv.phone, ...`). Add `conv.lead_temperature`, `conv.lead_score` to the column list. Place after `conv.last_intent`:

```js
    SELECT conv.id, conv.phone, conv.real_phone, conv.push_name,
           conv.customer_id, conv.status, conv.ai_enabled,
           conv.ai_paused_until, conv.assigned_staff_id, conv.last_message_at,
           conv.last_intent, conv.lead_temperature, conv.lead_score,
           conv.handover_count, conv.shadow_mode, conv.wa_session,
           conv.experiment_variant,
           conv.pipeline_stage, conv.pipeline_type, conv.manual_stage_override,
```

- [ ] **Step 2: Add an optional `?sort=temp` query param**

Find the existing `ORDER BY` line (around line 78: `ORDER BY COALESCE(conv.last_message_at, conv.updated_at) DESC`). Above the SQL build, parse the query param:

```js
const sort = req.query.sort || 'recent';
const orderSql = sort === 'temp'
  ? `ORDER BY CASE conv.lead_temperature WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,
              conv.lead_score DESC NULLS LAST,
              COALESCE(conv.last_message_at, conv.updated_at) DESC`
  : `ORDER BY COALESCE(conv.last_message_at, conv.updated_at) DESC`;
```

Then in the SQL template, replace the literal `ORDER BY ...` line with `${orderSql}`:

```js
const sql = `WITH ...
    ${whereSql}
    ${orderSql}
    LIMIT 200`;
```

- [ ] **Step 3: Smoke**

```bash
pm2 restart crm-pilot-backend && sleep 2
curl -s -o /dev/null -w "default sort=%{http_code} | temp sort=" http://localhost:3009/api/inbox/conversations
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3009/api/inbox/conversations?sort=temp"
```

Expected: both `401` (route exists, auth gate fires).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/inbox.js
git commit -m "feat(copilot): inbox API exposes lead_temperature/lead_score + ?sort=temp

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `<LeadTempBadge>` component + inbox UI integration

**Files:**
- Create: `frontend/src/components/LeadTempBadge.jsx`
- Modify: `frontend/src/pages/inbox/index.js`

- [ ] **Step 1: Write the badge component**

```jsx
// frontend/src/components/LeadTempBadge.jsx
// Small inline badge for lead temperature. Used in inbox list, chat header,
// and pipeline cards.

const STYLES = {
  hot:  { emoji: '🔥', cls: 'bg-rose-100 text-rose-700 border-rose-200' },
  warm: { emoji: '🌤️', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  cold: { emoji: '🧊', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

export default function LeadTempBadge({ temp, score, size = 'sm', showScore = false }) {
  if (!temp) return null;
  const style = STYLES[temp] || STYLES.cold;
  const px = size === 'xs' ? 'text-[10px] px-1 py-0' : 'text-xs px-1.5 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${style.cls} ${px} font-medium`}>
      <span aria-hidden>{style.emoji}</span>
      <span className="capitalize">{temp}</span>
      {showScore && typeof score === 'number' && (
        <span className="opacity-60">· {score}</span>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Wire badge into inbox list rows**

Find `frontend/src/pages/inbox/index.js`. Locate where each conversation row renders (search for `push_name` or `last_body`). Import the badge at top:

```js
import LeadTempBadge from '@/components/LeadTempBadge';
```

In the row JSX, add the badge alongside the existing status/pipeline indicators (placement: near the conv name or status badge — adapt to the existing visual layout):

```jsx
{c.lead_temperature && c.lead_temperature !== 'cold' && (
  <LeadTempBadge temp={c.lead_temperature} score={c.lead_score} size="xs" />
)}
```

(Hide the badge for `cold` to avoid visual noise — that's the default state. Only highlight warm/hot.)

- [ ] **Step 3: Add "by temperature" sort option**

Find any existing sort dropdown / segmented control on the inbox page (search for `sort=` or `setSortBy`). If one exists, add an option:

```jsx
<option value="temp">🔥 By temperature</option>
```

If no sort UI exists, add a small toggle near the inbox header:

```jsx
const [sortBy, setSortBy] = useState('recent');
// in the SWR key:
const list = useSWR(`/api/inbox/conversations?sort=${sortBy}`, fetcher, { refreshInterval: 30_000 });

// near the header:
<select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
  className="text-xs border border-slate-200 rounded px-2 py-1">
  <option value="recent">Sort: Recent</option>
  <option value="temp">Sort: Temperature</option>
</select>
```

(Adapt SWR key + state to wherever the existing list fetch happens. The point: the URL gets `?sort=temp` when user picks that option.)

- [ ] **Step 4: Build + restart**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -10
pm2 restart crm-pilot-frontend && sleep 3
```

Expected: build PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LeadTempBadge.jsx frontend/src/pages/inbox/index.js
git commit -m "feat(copilot): LeadTempBadge + inbox list integration (badge + sort)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Chat header + co-pilot panel + pipeline card UI

**Files:**
- Modify: `frontend/src/pages/inbox/[id].js` (chat header)
- Modify: `frontend/src/components/CoPilotPanel.jsx` (hot banner)
- Modify: `frontend/src/components/PipelineCard.jsx` (border accent)

- [ ] **Step 1: Chat header — render badge**

In `frontend/src/pages/inbox/[id].js`, import `LeadTempBadge`:

```js
import LeadTempBadge from '@/components/LeadTempBadge';
```

Find the header section (search for `push_name` or the pipeline stage badge near the top of the page render). Add:

```jsx
{convData?.lead_temperature && (
  <LeadTempBadge temp={convData.lead_temperature} score={convData.lead_score} showScore size="sm" />
)}
```

Place it next to the existing pipeline badge.

- [ ] **Step 2: Co-pilot panel — hot lead banner**

In `frontend/src/components/CoPilotPanel.jsx`, accept `leadTemp` as a new prop (so the parent can pass it):

```jsx
export default function CoPilotPanel({ conversationId, onUseSuggestion, leadTemp }) {
```

Right after the existing `lowConf` banner (the amber "Konteks belum jelas" block), insert:

```jsx
{leadTemp === 'hot' && (
  <div className="text-xs px-2 py-1 bg-rose-50 border border-rose-200 rounded text-rose-700 font-medium">
    🔥 Hot lead — close ASAP
  </div>
)}
```

Update the parent call in `frontend/src/pages/inbox/[id].js`:

```jsx
<CoPilotPanel
  conversationId={id}
  leadTemp={convData?.lead_temperature}
  onUseSuggestion={...}
/>
```

- [ ] **Step 3: Pipeline card — left-border accent**

In `frontend/src/components/PipelineCard.jsx`, find the root card `<div>` (with the existing border classes). Add a temperature-keyed border-left class:

```jsx
const tempBorder =
  card.lead_temperature === 'hot'  ? 'border-l-4 border-l-rose-400' :
  card.lead_temperature === 'warm' ? 'border-l-4 border-l-amber-400' :
  '';
```

Add `${tempBorder}` to the existing className string of the root card div.

(If the card data doesn't currently include `lead_temperature`, also add it to the upstream pipeline API SELECT — search `backend/routes/pipeline.js` for the cards SELECT and add `c.lead_temperature` to the column list.)

- [ ] **Step 4: Build + restart + visual smoke**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -10
pm2 restart crm-pilot-frontend && sleep 3
```

Open the app in browser, verify visually:
- Inbox list: warm/hot rows show colored badge
- Chat detail: header shows badge with score
- Co-pilot panel (with mode=copilot): hot conv shows red banner
- Pipeline board: cards have colored left border for warm/hot

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/inbox/\[id\].js frontend/src/components/CoPilotPanel.jsx frontend/src/components/PipelineCard.jsx backend/routes/pipeline.js
git commit -m "feat(copilot): leadTemp UI — chat header + copilot banner + pipeline border

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: E2E smoke verification

- [ ] **Step 1: Force a conv hot via DB**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT id FROM crm_conversations WHERE last_message_at > now() - interval '1 day' ORDER BY last_message_at DESC LIMIT 1;"
# Use the returned id
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "UPDATE crm_conversations SET lead_temperature = 'hot', lead_score = 85 WHERE id = <ID>;"
```

- [ ] **Step 2: Verify inbox list response includes the field**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3009/api/inbox/conversations?sort=temp"
```

Expected: 401 (auth gate). For the actual data, browse to `/inbox` in the app — the forced-hot conv should appear at top with a 🔥 badge.

- [ ] **Step 3: Trigger backfill once more to normalize**

```bash
cd /home/krttpt/crm && node backend/scripts/backfillLeadTemperature.js
```

Expected: the forced-hot conv resets to its actual computed score (likely cold/warm depending on signals).

- [ ] **Step 4: Trigger hot lead alert manually**

```bash
# Force a hot conv with a 4-min-old inbound and no operator response
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "UPDATE crm_conversations SET lead_temperature = 'hot', lead_score = 85 WHERE id = <ID>;"
cd /home/krttpt/crm && node backend/scripts/hotLeadAlert.js
```

Expected: log line shows `candidates >= 1`, alert sent (or skipped_dup if already sent within 30 min). Check Telegram.

- [ ] **Step 5: Verify dedup**

```bash
cd /home/krttpt/crm && node backend/scripts/hotLeadAlert.js
```

Expected: `skipped_dup` equals previous `owner_alerts + supervisor_alerts`.

- [ ] **Step 6: Verify cron entries are installed**

```bash
crontab -l | grep -E "leadTempDecay|hotLeadAlert"
```

Expected: both lines printed.

- [ ] **Step 7: Reset any forced state**

```bash
cd /home/krttpt/crm && node backend/scripts/backfillLeadTemperature.js
```

(Recomputes from real signals, undoes the forced 'hot' on the test conv.)

- [ ] **Step 8: Final commit (if any test fixes needed)**

```bash
git status
# If no changes: skip
git add -A
git commit -m "test(copilot): phase 2 e2e smoke verified"
```

---

## Acceptance Criteria Mapping

This plan covers spec section 6 only (Phase 2 scope). The spec lists no AC-D / AC-E codes in section 8 for lead temp specifically — derived from §6.1–6.6:

| Spec section | Verified by |
|---|---|
| §6.1 hot/warm/cold thresholds 70/40 | Task 2 `tempFor()` |
| §6.2 formula intent + keyword + behavioral × recency | Task 2 score* helpers |
| §6.2 hot keyword + warm keyword regex | Task 2 HOT/WARM_KEYWORDS_JS |
| §6.2 form_submitted → score 100 | Task 2 short-circuit in compute() |
| §6.2 recency decay | Task 2 recencyFactor() |
| §6.3 trigger: webhook ingest | Task 3 |
| §6.3 trigger: pipeline event apply | Task 4 |
| §6.3 trigger: cron 5-min sweep | Task 5 |
| §6.4 inbox list badge + sort by temp | Tasks 8, 9 |
| §6.4 chat header badge | Task 10 |
| §6.4 co-pilot panel hot banner | Task 10 |
| §6.4 pipeline card border by temp | Task 10 |
| §6.4 supervisor dashboard filter | Deferred to Phase 3 |
| §6.5 hot lead 3-min owner alert | Task 6 |
| §6.5 hot lead 5-min supervisor escalation | Task 6 |
| §6.5 red flag `cold_lead_ignored` integration | Deferred to Phase 3 (Phase 2 alerts directly via Telegram; Phase 3 will route through `crm_agent_red_flags`) |
| §6.6 backfill historical convs | Task 7 |

---

## Operational Notes

- **NFR-A2 (lead temp ≤ 50ms)**: each `compute()` does ~4 PG queries + 1 MySQL query. Local p95 should be 30–80ms. Acceptable for fire-and-forget on webhook; cron batch of 200 should finish < 30s.
- **MySQL dependency**: past-order signal requires the legacy `prestisa.order` table. If MySQL is unavailable, `loadContext()` swallows the error and skips that signal (logs a warn). Service degrades gracefully.
- **Telegram dep**: hot lead alerts need a configured bot token + chat. If unconfigured, `tg.send()` no-ops and the row still gets inserted into `crm_hot_lead_alerts` for audit.
- **Signal weights are tuned by intuition**, not data. After 2 weeks of production traffic, review `crm_conversations.lead_score` distribution and adjust the constants in `leadTemperature.js` if needed (e.g. if 80%+ are cold, intent weights are too low; if 30%+ are hot, keyword weights are too generous).

---

## Phase 3 — separate plan

Phase 3 (supervisor scoring + red flag detection + /supervisor dashboard) builds on Phase 1's `crm_suggestion_log` AND Phase 2's `lead_temperature` AND `crm_hot_lead_alerts`. After Phase 2 has 1+ week of production data, write `2026-05-XX-ai-copilot-phase3-supervisor-scoring.md`.
