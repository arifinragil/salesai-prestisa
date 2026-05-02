# AI Co-Pilot Phase 3 — Supervisor Scoring + Red Flag Detection + /supervisor Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect 11 deterministic red-flag rules per agent, push critical incidents to Telegram, aggregate a daily 0–100 performance score per agent, and surface everything in a `/supervisor` dashboard with drilldown + resolve flow.

**Architecture:** A single `redFlagDetector` service exposes per-rule evaluators. Two crons (1-min real-time, 5-min batch) run subset of rules; nightly `scoreAggregator` rolls suggestion_log + handovers + csat + red flags into `crm_agent_daily_scores`. Critical flags push Telegram alerts via existing `telegramNotify`. Frontend adds `/supervisor` page (admin-only) with agent table + drilldown.

**Tech Stack:** Node 20 + Express 5, PostgreSQL (pg), Telegram bot, Next.js 14 + Tailwind v3 + SWR. No new external deps.

**Spec reference:** `docs/specs/2026-05-02-ai-copilot-supervisor-design.md` section 5.

**DB state assumed:** Phase 1 migration `015_copilot.sql` already created `crm_agent_red_flags` + `crm_agent_daily_scores` + `crm_conversations.first_inbound_at` / `first_response_at`. Phase 2 added `crm_hot_lead_alerts`. Phase 3 only adds a tiny `018_pii_blacklist.sql` migration for the `policy_violation` keyword list.

**Out of scope (deferred):**
- `discount_unauthorized` red flag — depends on a `crm_promos` table that doesn't exist. Mark as TODO; safe to add later.
- ML-based scoring — spec ADR #7 explicitly defers to after 3mo data.
- Per-agent Telegram chat binding (already exists via `telegramNotify.sendToStaff`).

---

## File Map

**Backend create:**
- `backend/migrations/018_policy_blacklist.sql` — settings rows for `policy_keyword_blacklist` + `pii_patterns_extra`
- `backend/services/redFlagDetector.js` — rule evaluators + insert helper
- `backend/services/scoreAggregator.js` — nightly composite score formula
- `backend/scripts/redFlagRealtime.js` — cron 1-min: `cold_lead_ignored`, `flagged_suggestion`, `pii_leak`, `policy_violation`
- `backend/scripts/missedFollowup.js` — cron 5-min: `missed_followup`, `slow_first_response`, `suggestion_deviation`, `manual_override_high`, `lost_no_reason`, `csat_low`, `handover_overuse`
- `backend/scripts/scoreAggregatorCron.js` — cron nightly wrapper
- `backend/routes/supervisor.js` — REST endpoints

**Backend modify:**
- `backend/routes/webhook.js` — set `first_inbound_at` on first inbound per conv
- `backend/routes/inbox.js` — set `first_response_at` on first operator outbound per conv
- `backend/services/aiAgent.js` — same as inbox (when AI sends in auto mode it counts as response — but spec is operator-focused so SKIP for AI; only operator outbound counts)
- `backend/index.js` — mount supervisor router

**Frontend create:**
- `frontend/src/pages/supervisor/index.js` — agent table page (admin-gated)
- `frontend/src/pages/supervisor/[staffId].js` — drilldown page
- `frontend/src/components/RedFlagBadge.jsx` — severity-colored badge
- `frontend/src/components/PerformanceTierPill.jsx` — Excellent/Solid/Needs/Coaching pill

**Frontend modify:**
- `frontend/src/components/Layout.jsx` (or wherever navbar lives) — add "Supervisor" link visible to admins

**Cron install (system crontab `/etc/cron.d/crm-pilot`):**
- `* * * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/redFlagRealtime.js …`
- `*/5 * * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/missedFollowup.js …`
- `0 1 * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/scoreAggregatorCron.js …`

---

## Task 1: Migration `018_policy_blacklist.sql`

**Files:**
- Create: `backend/migrations/018_policy_blacklist.sql`

- [ ] **Step 1: Write migration**

```sql
-- 018_policy_blacklist.sql — settings for PII + policy keyword detection
BEGIN;

-- Default policy keyword blacklist (lowercase, JSON array). Editable via /admin later.
INSERT INTO crm_settings (key, value) VALUES
  ('policy_keyword_blacklist', '["refund pasti","100% refund","garansi seumur hidup","pasti untung","dijamin laku","money back"]'::jsonb),
  ('pii_extra_patterns', '[]'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
```

- [ ] **Step 2: Apply**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -f backend/migrations/018_policy_blacklist.sql
```

Expected: `BEGIN ... INSERT 0 2 ... COMMIT` (or `INSERT 0 0` if already present).

- [ ] **Step 3: Verify**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT key, value FROM crm_settings WHERE key IN ('policy_keyword_blacklist','pii_extra_patterns');"
```

Expected: 2 rows.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/018_policy_blacklist.sql
git commit -m "feat(db): migration 018 — policy keyword blacklist seeds

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire `first_inbound_at` / `first_response_at`

**Files:**
- Modify: `backend/routes/webhook.js`
- Modify: `backend/routes/inbox.js` (the `/conversations/:id/send` operator endpoint)

The two columns are needed by `slow_first_response` red flag (spec §5.1 row 1). They were added in migration 015 but never populated.

- [ ] **Step 1: Wire `first_inbound_at` in webhook**

In `backend/routes/webhook.js`, find the `INSERT INTO crm_conversations ... ON CONFLICT (phone) DO UPDATE` block (around line 47) and ensure subsequent code captures the conv row. Then after the message INSERT (around line 99 — after `RETURNING id, created_at`), add:

```js
    // Set first_inbound_at on the first inbound message for this conv (atomic, idempotent).
    await client.query(
      `UPDATE crm_conversations SET first_inbound_at = COALESCE(first_inbound_at, $2)
       WHERE id = $1`,
      [conv.id, msg.created_at]
    );
```

(Use `COALESCE(first_inbound_at, $2)` so it's only set on first inbound — subsequent inbounds leave it alone.)

- [ ] **Step 2: Wire `first_response_at` in operator send**

In `backend/routes/inbox.js`, find the operator send endpoint `POST /conversations/:id/send` (around line 206). After the outbound message INSERT, add:

```js
  await pg.query(
    `UPDATE crm_conversations SET first_response_at = COALESCE(first_response_at, now())
     WHERE id = $1 AND first_inbound_at IS NOT NULL`,
    [convId]
  );
```

(Only set if conv has had an inbound — avoid setting on cron outbound that arrives before any inbound.)

- [ ] **Step 3: Backfill historical data (one-shot SQL)**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports <<'EOF'
-- Backfill first_inbound_at from existing inbound messages
UPDATE crm_conversations c
SET first_inbound_at = sub.min_at
FROM (
  SELECT conversation_id, MIN(created_at) AS min_at
  FROM crm_messages WHERE direction = 'in' GROUP BY conversation_id
) sub
WHERE c.id = sub.conversation_id AND c.first_inbound_at IS NULL;

-- Backfill first_response_at from first operator outbound after first inbound
UPDATE crm_conversations c
SET first_response_at = sub.min_at
FROM (
  SELECT m.conversation_id, MIN(m.created_at) AS min_at
  FROM crm_messages m
  JOIN crm_conversations cc ON cc.id = m.conversation_id
  WHERE m.direction = 'out'
    AND m.sender_type = 'operator'
    AND cc.first_inbound_at IS NOT NULL
    AND m.created_at > cc.first_inbound_at
  GROUP BY m.conversation_id
) sub
WHERE c.id = sub.conversation_id AND c.first_response_at IS NULL;
EOF
```

Expected: `UPDATE <n>` printed twice.

- [ ] **Step 4: Restart backend + smoke**

```bash
pm2 restart crm-pilot-backend && sleep 2
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT id, first_inbound_at IS NOT NULL AS has_in, first_response_at IS NOT NULL AS has_resp FROM crm_conversations WHERE last_message_at > now() - interval '7 days' LIMIT 5;"
```

Expected: most rows have `has_in = t`. `has_resp` will be sparse (only convs where operator replied manually).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/webhook.js backend/routes/inbox.js
git commit -m "feat(supervisor): wire first_inbound_at / first_response_at + backfill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `redFlagDetector.js` service

**Files:**
- Create: `backend/services/redFlagDetector.js`

This is the core of Phase 3. Single file with one rule per function + a generic insert helper. Rules are pure SQL where possible, returning `Array<{staff_id, conversation_id, rule_id, severity, detail}>`.

- [ ] **Step 1: Write the service**

```js
// backend/services/redFlagDetector.js
// Per-rule evaluators for supervisor red flags. See spec §5.1.
//
// Each rule fn returns an array of candidate red flag rows.
// `record(candidates)` inserts them, deduping by (staff_id, conversation_id, rule_id)
// within a 24h window so the same incident isn't logged on every cron tick.

const pg = require('../db/postgres');
const settings = require('./settings');
const logger = require('./logger');

// Helper: insert flags, deduped by (staff, conv, rule) within 24h
async function record(candidates) {
  let inserted = 0;
  for (const c of candidates) {
    if (!c.staff_id || !c.rule_id || !c.severity) continue;
    const dup = await pg.query(
      `SELECT 1 FROM crm_agent_red_flags
       WHERE staff_id = $1 AND rule_id = $2
         AND COALESCE(conversation_id, -1) = COALESCE($3::int, -1)
         AND detected_at > now() - interval '24 hours'
         AND resolved_at IS NULL
       LIMIT 1`,
      [c.staff_id, c.rule_id, c.conversation_id || null]
    );
    if (dup.rows.length) continue;
    await pg.query(
      `INSERT INTO crm_agent_red_flags (staff_id, conversation_id, rule_id, severity, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [c.staff_id, c.conversation_id || null, c.rule_id, c.severity, JSON.stringify(c.detail || {})]
    );
    inserted++;
  }
  return inserted;
}

// ── Rule: slow_first_response (high) ─────────────────────────────────────
// First operator response > sla seconds (default 60).
async function ruleSlowFirstResponse() {
  const sla = await settings.getSetting('first_response_sla_seconds', 60);
  const r = await pg.query(
    `SELECT c.id AS conversation_id, c.assigned_staff_id AS staff_id,
            EXTRACT(EPOCH FROM (c.first_response_at - c.first_inbound_at))::int AS resp_sec
     FROM crm_conversations c
     WHERE c.first_inbound_at IS NOT NULL
       AND c.first_response_at IS NOT NULL
       AND c.assigned_staff_id IS NOT NULL
       AND c.first_inbound_at > now() - interval '24 hours'
       AND EXTRACT(EPOCH FROM (c.first_response_at - c.first_inbound_at)) > $1`,
    [sla]
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'slow_first_response',
    severity: 'high',
    detail: { resp_sec: row.resp_sec, sla_sec: sla },
  }));
}

// ── Rule: missed_followup (high) ─────────────────────────────────────────
// qualified/proposal_sent stage but no outbound > followup_sop_minutes.
async function ruleMissedFollowup() {
  const sop = await settings.getSetting('followup_sop_minutes', 30);
  const r = await pg.query(
    `SELECT c.id AS conversation_id, c.assigned_staff_id AS staff_id,
            c.pipeline_stage,
            EXTRACT(EPOCH FROM (now() - c.pipeline_stage_at))::int / 60 AS stale_min
     FROM crm_conversations c
     WHERE c.pipeline_stage IN ('qualified','proposal_sent')
       AND c.status = 'active'
       AND c.assigned_staff_id IS NOT NULL
       AND c.pipeline_stage_at < now() - ($1 || ' minutes')::interval
       AND NOT EXISTS (
         SELECT 1 FROM crm_messages m
         WHERE m.conversation_id = c.id AND m.direction = 'out'
           AND m.sender_type IN ('operator','ai')
           AND m.created_at > c.pipeline_stage_at
       )`,
    [String(sop)]
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'missed_followup',
    severity: 'high',
    detail: { stage: row.pipeline_stage, stale_min: row.stale_min, sop_min: sop },
  }));
}

// ── Rule: suggestion_deviation (medium) ──────────────────────────────────
// edit_distance > threshold ≥5×/day per staff.
async function ruleSuggestionDeviation() {
  const thr = await settings.getSetting('suggestion_deviation_threshold', 0.3);
  const r = await pg.query(
    `SELECT staff_id, COUNT(*) AS n
     FROM crm_suggestion_log
     WHERE staff_id IS NOT NULL
       AND usage_type = 'edited'
       AND edit_distance > $1
       AND shown_at > now() - interval '24 hours'
     GROUP BY staff_id HAVING COUNT(*) >= 5`,
    [thr]
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    rule_id: 'suggestion_deviation',
    severity: 'medium',
    detail: { high_edit_count: parseInt(row.n), threshold: thr },
  }));
}

// ── Rule: manual_override_high (medium) ──────────────────────────────────
// usage_type=manual rate > 50% per staff per day.
async function ruleManualOverrideHigh() {
  const r = await pg.query(
    `SELECT staff_id,
            SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::int AS manual,
            COUNT(*)::int AS total
     FROM crm_suggestion_log
     WHERE staff_id IS NOT NULL
       AND usage_type IS NOT NULL
       AND shown_at > now() - interval '24 hours'
     GROUP BY staff_id HAVING COUNT(*) >= 5 AND
       SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::float / COUNT(*) > 0.5`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    rule_id: 'manual_override_high',
    severity: 'medium',
    detail: { manual: row.manual, total: row.total, ratio: Number((row.manual / row.total).toFixed(2)) },
  }));
}

// ── Rule: flagged_suggestion (low) ───────────────────────────────────────
// Operator marked a suggestion harmful/off_tone in last 24h.
async function ruleFlaggedSuggestion() {
  const r = await pg.query(
    `SELECT id, staff_id, conversation_id, flagged_reason
     FROM crm_suggestion_log
     WHERE flagged_reason IN ('harmful','off_tone')
       AND shown_at > now() - interval '24 hours'
       AND staff_id IS NOT NULL`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'flagged_suggestion',
    severity: 'low',
    detail: { suggestion_log_id: row.id, reason: row.flagged_reason },
  }));
}

// ── Rule: lost_no_reason (medium) ────────────────────────────────────────
// Conv transitioned to 'lost' without a lost_reason in last 24h.
async function ruleLostNoReason() {
  const r = await pg.query(
    `SELECT c.id AS conversation_id, c.assigned_staff_id AS staff_id
     FROM crm_conversations c
     WHERE c.pipeline_stage = 'lost'
       AND c.lost_reason IS NULL
       AND c.assigned_staff_id IS NOT NULL
       AND c.pipeline_stage_at > now() - interval '24 hours'`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'lost_no_reason',
    severity: 'medium',
    detail: {},
  }));
}

// ── Rule: csat_low (high) ────────────────────────────────────────────────
// CSAT score 1 or 2 in last 7 days.
async function ruleCsatLow() {
  const r = await pg.query(
    `SELECT cs.id AS csat_id, cs.score, cs.conversation_id, c.assigned_staff_id AS staff_id
     FROM crm_csat cs JOIN crm_conversations c ON c.id = cs.conversation_id
     WHERE cs.score <= 2
       AND cs.collected_at > now() - interval '7 days'
       AND c.assigned_staff_id IS NOT NULL`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'csat_low',
    severity: 'high',
    detail: { csat_id: row.csat_id, score: row.score },
  }));
}

// ── Rule: pii_leak (critical) ────────────────────────────────────────────
// Outbound contains a phone number that doesn't match the conv's phone — likely
// pasted from another customer. Pattern: 8+ digit numeric strings starting 62/0/1.
async function rulePiiLeak() {
  const PHONE_RE = /(?<!\d)(?:62|0)[\s.-]?\d{2,4}[\s.-]?\d{3,5}[\s.-]?\d{3,5}(?!\d)/g;
  const r = await pg.query(
    `SELECT m.id AS msg_id, m.conversation_id, m.body, c.phone, c.real_phone, c.assigned_staff_id AS staff_id
     FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'out' AND m.sender_type = 'operator'
       AND m.created_at > now() - interval '1 hour'
       AND c.assigned_staff_id IS NOT NULL`
  );
  const flags = [];
  for (const row of r.rows) {
    const matches = String(row.body || '').match(PHONE_RE);
    if (!matches) continue;
    const ownPhones = [row.phone, row.real_phone].filter(Boolean).map((p) => String(p).replace(/\D/g, ''));
    const leaked = matches.filter((m) => {
      const norm = m.replace(/\D/g, '');
      return !ownPhones.some((p) => p.includes(norm) || norm.includes(p));
    });
    if (leaked.length === 0) continue;
    flags.push({
      staff_id: row.staff_id,
      conversation_id: row.conversation_id,
      rule_id: 'pii_leak',
      severity: 'critical',
      detail: { msg_id: row.msg_id, leaked_numbers: leaked.slice(0, 3) },
    });
  }
  return flags;
}

// ── Rule: policy_violation (high) ────────────────────────────────────────
// Outbound matches keyword from policy_keyword_blacklist.
async function rulePolicyViolation() {
  const blacklist = await settings.getSetting('policy_keyword_blacklist', []);
  if (!Array.isArray(blacklist) || blacklist.length === 0) return [];
  const r = await pg.query(
    `SELECT m.id AS msg_id, m.conversation_id, m.body, c.assigned_staff_id AS staff_id
     FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE m.direction = 'out' AND m.sender_type = 'operator'
       AND m.created_at > now() - interval '1 hour'
       AND c.assigned_staff_id IS NOT NULL`
  );
  const flags = [];
  for (const row of r.rows) {
    const lower = String(row.body || '').toLowerCase();
    const hit = blacklist.find((kw) => lower.includes(String(kw).toLowerCase()));
    if (!hit) continue;
    flags.push({
      staff_id: row.staff_id,
      conversation_id: row.conversation_id,
      rule_id: 'policy_violation',
      severity: 'high',
      detail: { msg_id: row.msg_id, keyword: hit },
    });
  }
  return flags;
}

// ── Rule: cold_lead_ignored (critical) ───────────────────────────────────
// Promote Phase 2's hot lead alerts (kind=supervisor_5min) into red flags.
async function ruleColdLeadIgnored() {
  const r = await pg.query(
    `SELECT a.id AS alert_id, a.conversation_id, a.staff_id, a.sent_at, c.assigned_staff_id
     FROM crm_hot_lead_alerts a
     JOIN crm_conversations c ON c.id = a.conversation_id
     WHERE a.alert_kind = 'supervisor_5min'
       AND a.sent_at > now() - interval '24 hours'`
  );
  return r.rows.map((row) => ({
    staff_id: row.assigned_staff_id || row.staff_id,
    conversation_id: row.conversation_id,
    rule_id: 'cold_lead_ignored',
    severity: 'critical',
    detail: { alert_id: row.alert_id, alerted_at: row.sent_at },
  })).filter((f) => f.staff_id);
}

// ── Rule: handover_overuse (low) ─────────────────────────────────────────
// Operator handover > 30% of assigned convs in last 7 days.
async function ruleHandoverOveruse() {
  const r = await pg.query(
    `SELECT c.assigned_staff_id AS staff_id,
            COUNT(DISTINCT c.id) FILTER (WHERE h.id IS NOT NULL)::int AS handovers,
            COUNT(DISTINCT c.id)::int AS total
     FROM crm_conversations c
     LEFT JOIN crm_handovers h ON h.conversation_id = c.id AND h.created_at > now() - interval '7 days'
     WHERE c.assigned_staff_id IS NOT NULL
       AND c.last_message_at > now() - interval '7 days'
     GROUP BY c.assigned_staff_id
     HAVING COUNT(DISTINCT c.id) >= 5
        AND COUNT(DISTINCT c.id) FILTER (WHERE h.id IS NOT NULL)::float / COUNT(DISTINCT c.id) > 0.3`
  );
  return r.rows.map((row) => ({
    staff_id: row.staff_id,
    rule_id: 'handover_overuse',
    severity: 'low',
    detail: { handovers: row.handovers, total: row.total, ratio: Number((row.handovers / row.total).toFixed(2)) },
  }));
}

// Real-time set: cheap, 1-min cadence
async function evaluateRealtime() {
  const all = [
    ...(await ruleColdLeadIgnored().catch((e) => (logger.warn({err:e.message},'ruleColdLeadIgnored'),[]))),
    ...(await ruleFlaggedSuggestion().catch((e) => (logger.warn({err:e.message},'ruleFlaggedSuggestion'),[]))),
    ...(await rulePiiLeak().catch((e) => (logger.warn({err:e.message},'rulePiiLeak'),[]))),
    ...(await rulePolicyViolation().catch((e) => (logger.warn({err:e.message},'rulePolicyViolation'),[]))),
  ];
  return all;
}

// Batch set: 5-min cadence
async function evaluateBatch() {
  const all = [
    ...(await ruleSlowFirstResponse().catch((e) => (logger.warn({err:e.message},'ruleSlowFirstResponse'),[]))),
    ...(await ruleMissedFollowup().catch((e) => (logger.warn({err:e.message},'ruleMissedFollowup'),[]))),
    ...(await ruleSuggestionDeviation().catch((e) => (logger.warn({err:e.message},'ruleSuggestionDeviation'),[]))),
    ...(await ruleManualOverrideHigh().catch((e) => (logger.warn({err:e.message},'ruleManualOverrideHigh'),[]))),
    ...(await ruleLostNoReason().catch((e) => (logger.warn({err:e.message},'ruleLostNoReason'),[]))),
    ...(await ruleCsatLow().catch((e) => (logger.warn({err:e.message},'ruleCsatLow'),[]))),
    ...(await ruleHandoverOveruse().catch((e) => (logger.warn({err:e.message},'ruleHandoverOveruse'),[]))),
  ];
  return all;
}

module.exports = {
  evaluateRealtime,
  evaluateBatch,
  record,
  // Exposed for unit tests / debugging
  ruleSlowFirstResponse, ruleMissedFollowup, ruleSuggestionDeviation,
  ruleManualOverrideHigh, ruleFlaggedSuggestion, ruleLostNoReason,
  ruleCsatLow, rulePiiLeak, rulePolicyViolation, ruleColdLeadIgnored,
  ruleHandoverOveruse,
};
```

- [ ] **Step 2: Smoke test all rules**

```bash
cd /home/krttpt/crm/backend && node -e "
require('dotenv').config({ path: '../.env' });
(async () => {
  const det = require('./services/redFlagDetector');
  const rt = await det.evaluateRealtime();
  const bt = await det.evaluateBatch();
  console.log('REALTIME candidates:', rt.length, JSON.stringify(rt.slice(0,3), null, 2));
  console.log('BATCH    candidates:', bt.length, JSON.stringify(bt.slice(0,3), null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected: prints two arrays. Counts will be small (likely 0 on a quiet dev DB) but no SQL errors.

- [ ] **Step 3: Commit**

```bash
git add backend/services/redFlagDetector.js
git commit -m "feat(supervisor): redFlagDetector — 11 deterministic rule evaluators

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Real-time detector cron `redFlagRealtime.js`

**Files:**
- Create: `backend/scripts/redFlagRealtime.js`

Runs every minute. Critical findings push Telegram alerts to supervisor.

- [ ] **Step 1: Write script**

```js
// backend/scripts/redFlagRealtime.js
// Every 1 min: evaluate critical/high real-time red flags.
// Critical findings → Telegram push to supervisor chat.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const det = require('../services/redFlagDetector');
const tg = require('../services/telegramNotify');
const settings = require('../services/settings');
const logger = require('../services/logger');

async function notifyCritical(flag) {
  try {
    const supChat = await settings.getSetting('telegram_chat_sla', null) ||
                    await settings.getSetting('telegram_chat_id', null);
    if (!supChat) return;
    const text = `🚨 RED FLAG (${flag.severity})\n` +
                 `Rule: ${flag.rule_id}\n` +
                 `Staff #${flag.staff_id}` +
                 (flag.conversation_id ? ` · Conv #${flag.conversation_id}` : '') + `\n` +
                 (flag.detail ? `Detail: ${JSON.stringify(flag.detail).slice(0,200)}` : '');
    await tg.send(text, { _overrideChatId: supChat });
  } catch (err) {
    logger.warn({ err: err.message }, '[redFlagRealtime] telegram push failed');
  }
}

async function run() {
  const candidates = await det.evaluateRealtime();
  let inserted = 0, alerted = 0;
  for (const c of candidates) {
    const n = await det.record([c]);
    if (n > 0) {
      inserted++;
      if (c.severity === 'critical') {
        await notifyCritical(c);
        alerted++;
      }
    }
  }
  logger.info({ candidates: candidates.length, inserted, alerted }, '[redFlagRealtime] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[redFlagRealtime] failed'); process.exit(1); });
}
module.exports = { run };
```

- [ ] **Step 2: Test**

```bash
cd /home/krttpt/crm && node backend/scripts/redFlagRealtime.js
```

Expected: log line `[redFlagRealtime] done candidates=<n> inserted=<n> alerted=<n>`. Counts likely 0 on quiet dev DB.

- [ ] **Step 3: Install cron**

```bash
echo '# Red flag detector (real-time) — every 1 min
* * * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/redFlagRealtime.js >> /home/krttpt/crm/logs/cron-redflag-rt.log 2>&1' | sudo tee -a /etc/cron.d/crm-pilot > /dev/null
grep -A1 "Red flag detector .real-time" /etc/cron.d/crm-pilot
```

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/redFlagRealtime.js
git commit -m "feat(supervisor): redFlagRealtime cron — 1-min critical/realtime rules + TG alert

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Batch detector cron `missedFollowup.js`

**Files:**
- Create: `backend/scripts/missedFollowup.js`

Despite the file name (kept for spec consistency), this runs ALL batch rules every 5 min, not just missed_followup.

- [ ] **Step 1: Write script**

```js
// backend/scripts/missedFollowup.js
// Every 5 min: evaluate batch red flags (slow_first_response, missed_followup,
// suggestion_deviation, manual_override_high, lost_no_reason, csat_low,
// handover_overuse).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const det = require('../services/redFlagDetector');
const logger = require('../services/logger');

async function run() {
  const candidates = await det.evaluateBatch();
  const inserted = await det.record(candidates);
  logger.info({ candidates: candidates.length, inserted }, '[missedFollowup] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[missedFollowup] failed'); process.exit(1); });
}
module.exports = { run };
```

- [ ] **Step 2: Test**

```bash
cd /home/krttpt/crm && node backend/scripts/missedFollowup.js
```

Expected: log line `[missedFollowup] done candidates=<n> inserted=<n>`.

- [ ] **Step 3: Install cron**

```bash
echo '# Red flag detector (batch) — every 5 min
*/5 * * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/missedFollowup.js >> /home/krttpt/crm/logs/cron-redflag-batch.log 2>&1' | sudo tee -a /etc/cron.d/crm-pilot > /dev/null
grep -A1 "Red flag detector .batch" /etc/cron.d/crm-pilot
```

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/missedFollowup.js
git commit -m "feat(supervisor): missedFollowup cron — 5-min batch rules

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `scoreAggregator.js` service

**Files:**
- Create: `backend/services/scoreAggregator.js`

Computes daily composite per staff per day. Single function `computeForDate(date)` writes one row per active staff into `crm_agent_daily_scores`.

- [ ] **Step 1: Write the service**

```js
// backend/services/scoreAggregator.js
// Computes the daily composite performance score per agent per day.
// See spec §5.2 for the formula.
const pg = require('../db/postgres');
const logger = require('./logger');

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function volumeFactor(n) {
  // Diminishing return after 50/day: 0..50 → linear 0..1, 50+ → asymptote ~1
  if (!n || n <= 0) return 0;
  return Math.min(1, n / 50);
}

/**
 * @param {Date|string} date — UTC date string 'YYYY-MM-DD' or Date object
 */
async function computeForDate(date) {
  const dateStr = (date instanceof Date)
    ? date.toISOString().slice(0, 10)
    : String(date).slice(0, 10);

  // Pull the core per-staff aggregates for the day
  const r = await pg.query(
    `WITH active_staff AS (
       SELECT DISTINCT staff_id FROM crm_suggestion_log
       WHERE staff_id IS NOT NULL AND shown_at::date = $1
       UNION
       SELECT DISTINCT assigned_staff_id AS staff_id FROM crm_conversations
       WHERE assigned_staff_id IS NOT NULL AND last_message_at::date = $1
     ),
     sug AS (
       SELECT staff_id,
              COUNT(*)::int AS shown,
              SUM(CASE WHEN usage_type='raw' THEN 1 ELSE 0 END)::int AS used_raw,
              SUM(CASE WHEN usage_type='edited' THEN 1 ELSE 0 END)::int AS used_edited,
              SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::int AS manual_count,
              AVG(edit_distance)::numeric(4,3) AS avg_edit
       FROM crm_suggestion_log
       WHERE staff_id IS NOT NULL AND shown_at::date = $1
       GROUP BY staff_id
     ),
     conv_agg AS (
       SELECT assigned_staff_id AS staff_id,
              COUNT(DISTINCT id)::int AS handled,
              COUNT(DISTINCT id) FILTER (WHERE pipeline_stage = 'paid')::int AS won,
              COUNT(DISTINCT id) FILTER (WHERE pipeline_stage = 'lost')::int AS lost,
              SUM(CASE WHEN pipeline_stage = 'paid' THEN deal_value_idr ELSE 0 END) AS value_won,
              AVG(EXTRACT(EPOCH FROM (first_response_at - first_inbound_at)))::int AS avg_resp_sec
       FROM crm_conversations
       WHERE assigned_staff_id IS NOT NULL AND last_message_at::date = $1
       GROUP BY assigned_staff_id
     ),
     msg_agg AS (
       SELECT c.assigned_staff_id AS staff_id, COUNT(m.id)::int AS msgs
       FROM crm_messages m JOIN crm_conversations c ON c.id = m.conversation_id
       WHERE c.assigned_staff_id IS NOT NULL
         AND m.direction = 'out' AND m.sender_type = 'operator'
         AND m.created_at::date = $1
       GROUP BY c.assigned_staff_id
     ),
     csat_agg AS (
       SELECT c.assigned_staff_id AS staff_id,
              AVG(cs.score)::numeric(3,2) AS csat_avg,
              COUNT(*)::int AS csat_n
       FROM crm_csat cs JOIN crm_conversations c ON c.id = cs.conversation_id
       WHERE c.assigned_staff_id IS NOT NULL
         AND cs.collected_at::date = $1
       GROUP BY c.assigned_staff_id
     ),
     flags_agg AS (
       SELECT staff_id,
              SUM(CASE WHEN severity='high' THEN 1 ELSE 0 END)::int AS rf_high,
              SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END)::int AS rf_critical,
              SUM(CASE WHEN rule_id='missed_followup' THEN 1 ELSE 0 END)::int AS missed_n
       FROM crm_agent_red_flags
       WHERE detected_at::date = $1
       GROUP BY staff_id
     )
     SELECT s.staff_id,
            COALESCE(c.handled,0) AS conv_handled,
            COALESCE(m.msgs,0) AS msg_sent,
            c.avg_resp_sec AS avg_response_time_sec,
            COALESCE(sg.shown,0) AS sug_shown,
            COALESCE(sg.used_raw,0) AS sug_used_raw,
            COALESCE(sg.used_edited,0) AS sug_used_edited,
            COALESCE(sg.manual_count,0) AS sug_manual,
            sg.avg_edit AS avg_edit_distance,
            COALESCE(c.won,0) AS won, COALESCE(c.lost,0) AS lost,
            COALESCE(c.value_won,0) AS value_won,
            cs.csat_avg, COALESCE(cs.csat_n,0) AS csat_n,
            COALESCE(f.rf_high,0) AS rf_high, COALESCE(f.rf_critical,0) AS rf_critical,
            COALESCE(f.missed_n,0) AS missed_n
     FROM active_staff s
     LEFT JOIN sug sg ON sg.staff_id = s.staff_id
     LEFT JOIN conv_agg c ON c.staff_id = s.staff_id
     LEFT JOIN msg_agg m ON m.staff_id = s.staff_id
     LEFT JOIN csat_agg cs ON cs.staff_id = s.staff_id
     LEFT JOIN flags_agg f ON f.staff_id = s.staff_id`,
    [dateStr]
  );

  let written = 0;
  for (const row of r.rows) {
    const closed = row.won + row.lost;
    const conversionRate = closed > 0 ? row.won / closed : 0;
    const sugFactor = row.sug_shown > 0
      ? (row.sug_used_raw + 0.7 * row.sug_used_edited) / row.sug_shown
      : 0;

    let score =
        25 * conversionRate
      + 20 * (1 - clamp((row.avg_response_time_sec || 300) / 300, 0, 1))
      + 15 * ((row.csat_avg || 0) / 5)
      + 15 * sugFactor
      +  5 * volumeFactor(row.conv_handled)
      - 10 * row.rf_high
      - 25 * row.rf_critical
      - (row.missed_n > 2 ? 10 : 0);

    score = clamp(Math.round(score * 100) / 100, 0, 100);

    await pg.query(
      `INSERT INTO crm_agent_daily_scores
        (staff_id, date, conv_handled, msg_sent, avg_response_time_sec,
         suggestion_shown, suggestion_used_raw, suggestion_used_edited, suggestion_manual,
         avg_edit_distance, conv_closed_won, conv_closed_lost, total_value_won,
         conversion_rate, red_flags_high, red_flags_critical,
         csat_avg, csat_count, performance_score, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       ON CONFLICT (staff_id, date) DO UPDATE SET
         conv_handled = EXCLUDED.conv_handled,
         msg_sent = EXCLUDED.msg_sent,
         avg_response_time_sec = EXCLUDED.avg_response_time_sec,
         suggestion_shown = EXCLUDED.suggestion_shown,
         suggestion_used_raw = EXCLUDED.suggestion_used_raw,
         suggestion_used_edited = EXCLUDED.suggestion_used_edited,
         suggestion_manual = EXCLUDED.suggestion_manual,
         avg_edit_distance = EXCLUDED.avg_edit_distance,
         conv_closed_won = EXCLUDED.conv_closed_won,
         conv_closed_lost = EXCLUDED.conv_closed_lost,
         total_value_won = EXCLUDED.total_value_won,
         conversion_rate = EXCLUDED.conversion_rate,
         red_flags_high = EXCLUDED.red_flags_high,
         red_flags_critical = EXCLUDED.red_flags_critical,
         csat_avg = EXCLUDED.csat_avg,
         csat_count = EXCLUDED.csat_count,
         performance_score = EXCLUDED.performance_score,
         computed_at = now()`,
      [row.staff_id, dateStr, row.conv_handled, row.msg_sent, row.avg_response_time_sec,
       row.sug_shown, row.sug_used_raw, row.sug_used_edited, row.sug_manual,
       row.avg_edit_distance, row.won, row.lost, row.value_won,
       conversionRate.toFixed(3), row.rf_high, row.rf_critical,
       row.csat_avg, row.csat_n, score]
    );
    written++;
  }
  logger.info({ date: dateStr, staff: r.rows.length, written }, '[scoreAggregator] done');
  return { staff: r.rows.length, written };
}

module.exports = { computeForDate };
```

- [ ] **Step 2: Smoke**

```bash
cd /home/krttpt/crm/backend && node -e "
require('dotenv').config({ path: '../.env' });
(async () => {
  const a = require('./services/scoreAggregator');
  const r = await a.computeForDate(new Date());
  console.log('result:', r);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT staff_id, date, conv_handled, performance_score FROM crm_agent_daily_scores WHERE date = current_date ORDER BY staff_id;"
```

Expected: result `{ staff: <n>, written: <n> }` and rows printed (may be empty if no staff was active today).

- [ ] **Step 3: Commit**

```bash
git add backend/services/scoreAggregator.js
git commit -m "feat(supervisor): scoreAggregator — daily composite per agent

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `scoreAggregatorCron.js` cron + install

**Files:**
- Create: `backend/scripts/scoreAggregatorCron.js`

- [ ] **Step 1: Write wrapper**

```js
// backend/scripts/scoreAggregatorCron.js
// Nightly: aggregate yesterday's daily scores. Runs at 01:00 WIB so all
// metrics for the previous day are stable.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const aggr = require('../services/scoreAggregator');
const logger = require('../services/logger');

async function run() {
  // Use yesterday in WIB. Server may be UTC; offset 7h.
  const now = new Date();
  const wibYesterday = new Date(now.getTime() + 7 * 3600_000 - 24 * 3600_000);
  const dateStr = wibYesterday.toISOString().slice(0, 10);
  const r = await aggr.computeForDate(dateStr);
  // Also recompute today (partial) for live dashboard
  await aggr.computeForDate(new Date());
  logger.info({ date: dateStr, ...r }, '[scoreAggregatorCron] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[scoreAggregatorCron] failed'); process.exit(1); });
}
```

- [ ] **Step 2: Test**

```bash
cd /home/krttpt/crm && node backend/scripts/scoreAggregatorCron.js
```

Expected: `[scoreAggregatorCron] done date=YYYY-MM-DD staff=<n> written=<n>`.

- [ ] **Step 3: Install cron**

```bash
echo '# Score aggregator — nightly at 01:00 WIB (18:00 UTC prev day)
0 18 * * * krttpt cd /home/krttpt/crm/backend && /usr/bin/node scripts/scoreAggregatorCron.js >> /home/krttpt/crm/logs/cron-score.log 2>&1' | sudo tee -a /etc/cron.d/crm-pilot > /dev/null
grep -A1 "Score aggregator" /etc/cron.d/crm-pilot
```

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/scoreAggregatorCron.js
git commit -m "feat(supervisor): scoreAggregatorCron — nightly composite at 01:00 WIB

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Supervisor REST API

**Files:**
- Create: `backend/routes/supervisor.js`
- Modify: `backend/index.js` (mount router)

- [ ] **Step 1: Write router**

```js
// backend/routes/supervisor.js
// Endpoints for /supervisor dashboard. Admin-only.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const router = express.Router();

router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

// GET /agents — table for landing page (today + 7d trend + open red flag count)
router.get('/agents', async (_req, res) => {
  const r = await pg.query(
    `WITH today AS (
       SELECT staff_id, performance_score, conv_handled, conversion_rate
       FROM crm_agent_daily_scores
       WHERE date = current_date
     ),
     trend AS (
       SELECT staff_id, AVG(performance_score)::numeric(5,2) AS avg7d,
              ARRAY_AGG(performance_score ORDER BY date) AS series
       FROM crm_agent_daily_scores
       WHERE date >= current_date - interval '6 days'
       GROUP BY staff_id
     ),
     flags AS (
       SELECT staff_id, COUNT(*)::int AS open_flags
       FROM crm_agent_red_flags WHERE resolved_at IS NULL
       GROUP BY staff_id
     )
     SELECT u.id AS staff_id, u.username, u.full_name, u.role,
            t.performance_score AS today_score,
            tr.avg7d AS avg7d_score, tr.series AS series7d,
            COALESCE(f.open_flags, 0) AS open_flags,
            t.conv_handled, t.conversion_rate
     FROM staff_users u
     LEFT JOIN today t ON t.staff_id = u.id
     LEFT JOIN trend tr ON tr.staff_id = u.id
     LEFT JOIN flags f ON f.staff_id = u.id
     WHERE u.active = TRUE AND u.role IN ('operator','admin')
     ORDER BY COALESCE(t.performance_score, 0) DESC, u.username`
  );
  res.json({ items: r.rows });
});

// GET /agents/:id — drilldown (red flags + recent score history + suggestion stats)
router.get('/agents/:id', async (req, res) => {
  const staffId = parseInt(req.params.id);
  if (!Number.isFinite(staffId)) return res.status(400).json({ error: 'bad_id' });
  const days = Math.min(90, parseInt(req.query.days) || 30);

  const [user, scores, flags, sugStats] = await Promise.all([
    pg.query(`SELECT id, username, full_name, role, active, last_login_at FROM staff_users WHERE id = $1`, [staffId]),
    pg.query(
      `SELECT * FROM crm_agent_daily_scores
       WHERE staff_id = $1 AND date >= current_date - ($2 || ' days')::interval
       ORDER BY date DESC`,
      [staffId, String(days)]
    ),
    pg.query(
      `SELECT id, conversation_id, rule_id, severity, detail,
              detected_at, resolved_at, resolved_by, resolution_note
       FROM crm_agent_red_flags
       WHERE staff_id = $1 AND detected_at >= now() - ($2 || ' days')::interval
       ORDER BY detected_at DESC`,
      [staffId, String(days)]
    ),
    pg.query(
      `SELECT date_trunc('day', shown_at)::date AS day,
              COUNT(*)::int AS shown,
              SUM(CASE WHEN usage_type='raw' THEN 1 ELSE 0 END)::int AS used_raw,
              SUM(CASE WHEN usage_type='edited' THEN 1 ELSE 0 END)::int AS used_edited,
              SUM(CASE WHEN usage_type='manual' THEN 1 ELSE 0 END)::int AS manual
       FROM crm_suggestion_log
       WHERE staff_id = $1 AND shown_at >= now() - ($2 || ' days')::interval
       GROUP BY day ORDER BY day DESC`,
      [staffId, String(days)]
    ),
  ]);

  if (!user.rows[0]) return res.status(404).json({ error: 'staff_not_found' });
  res.json({
    staff: user.rows[0],
    scores: scores.rows,
    flags: flags.rows,
    suggestion_stats: sugStats.rows,
  });
});

// POST /flags/:id/resolve — mark red flag resolved
router.post('/flags/:id/resolve', async (req, res) => {
  const flagId = parseInt(req.params.id);
  if (!Number.isFinite(flagId)) return res.status(400).json({ error: 'bad_id' });
  const note = String(req.body?.note || '').slice(0, 1000);
  const r = await pg.query(
    `UPDATE crm_agent_red_flags
     SET resolved_at = now(), resolved_by = $2, resolution_note = $3
     WHERE id = $1 AND resolved_at IS NULL
     RETURNING id`,
    [flagId, req.staff.staff_id, note || null]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_already_resolved' });
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 2: Mount in `backend/index.js`**

Add near other route mounts:

```js
const supervisorRoutes = require('./routes/supervisor');
app.use('/api/supervisor', supervisorRoutes);
```

- [ ] **Step 3: Restart + smoke**

```bash
pm2 restart crm-pilot-backend && sleep 2
for ep in /agents /agents/1 /flags/1/resolve; do
  curl -s -o /dev/null -w "GET/POST $ep -> %{http_code}\n" "http://localhost:3009/api/supervisor$ep"
done
```

Expected: `401` for all (auth gate fires before any handler).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/supervisor.js backend/index.js
git commit -m "feat(supervisor): REST API — agents table, drilldown, resolve flag

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Frontend `<RedFlagBadge>` + `<PerformanceTierPill>`

**Files:**
- Create: `frontend/src/components/RedFlagBadge.jsx`
- Create: `frontend/src/components/PerformanceTierPill.jsx`

- [ ] **Step 1: Write `RedFlagBadge.jsx`**

```jsx
// frontend/src/components/RedFlagBadge.jsx
const STYLE = {
  critical: { emoji: '🚨', cls: 'bg-rose-100 text-rose-700 border-rose-300' },
  high:     { emoji: '⚠',  cls: 'bg-orange-100 text-orange-700 border-orange-300' },
  medium:   { emoji: '⚡', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  low:      { emoji: '·',  cls: 'bg-slate-100 text-slate-600 border-slate-200' },
};

export default function RedFlagBadge({ severity, count, size = 'sm' }) {
  if (!severity) return null;
  const s = STYLE[severity] || STYLE.low;
  const px = size === 'xs' ? 'text-[10px] px-1 py-0' : 'text-xs px-1.5 py-0.5';
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${s.cls} ${px} font-medium`} title={severity}>
      <span aria-hidden>{s.emoji}</span>
      <span className="capitalize">{severity}</span>
      {typeof count === 'number' && count > 1 && <span className="opacity-70">×{count}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Write `PerformanceTierPill.jsx`**

```jsx
// frontend/src/components/PerformanceTierPill.jsx
export function tierFor(score) {
  if (score == null) return { label: '—', emoji: '·', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
  if (score >= 85) return { label: 'Excellent',   emoji: '🟢', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  if (score >= 70) return { label: 'Solid',       emoji: '🔵', cls: 'bg-sky-100 text-sky-700 border-sky-200' };
  if (score >= 55) return { label: 'Needs attn',  emoji: '🟡', cls: 'bg-amber-100 text-amber-700 border-amber-200' };
  return { label: 'Coaching',  emoji: '🔴', cls: 'bg-rose-100 text-rose-700 border-rose-200' };
}

export default function PerformanceTierPill({ score, showScore = false }) {
  const t = tierFor(typeof score === 'number' ? score : Number(score));
  return (
    <span className={`inline-flex items-center gap-1 rounded border ${t.cls} text-xs px-2 py-0.5 font-medium`}>
      <span aria-hidden>{t.emoji}</span>
      <span>{t.label}</span>
      {showScore && score != null && <span className="opacity-70">· {Number(score).toFixed(0)}</span>}
    </span>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -8
```

Expected: build PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/RedFlagBadge.jsx frontend/src/components/PerformanceTierPill.jsx
git commit -m "feat(supervisor): RedFlagBadge + PerformanceTierPill components

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `/supervisor` page (agent table)

**Files:**
- Create: `frontend/src/pages/supervisor/index.js`
- Modify: `frontend/src/components/Layout.jsx` (add nav link visible to admins)

- [ ] **Step 1: Write the agent table page**

```jsx
// frontend/src/pages/supervisor/index.js
import Link from 'next/link';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher } from '@/lib/api';
import PerformanceTierPill from '@/components/PerformanceTierPill';

function Sparkline({ series }) {
  if (!Array.isArray(series) || series.length === 0) return <span className="text-slate-300">—</span>;
  const vals = series.map((v) => Number(v) || 0);
  const max = Math.max(...vals, 1);
  return (
    <span className="inline-flex items-end gap-0.5 h-5">
      {vals.map((v, i) => (
        <span key={i}
          className="w-1 bg-sky-400 rounded-sm"
          style={{ height: `${Math.max(10, (v / max) * 100)}%` }}
          title={`${Math.round(v)}`} />
      ))}
    </span>
  );
}

export default function SupervisorIndex() {
  const me = useSWR('/api/auth/me', fetcher);
  const list = useSWR('/api/supervisor/agents', fetcher, { refreshInterval: 60_000 });
  const isAdmin = me.data?.user?.role === 'admin';

  if (me.data && !isAdmin) {
    return (
      <Layout title="Supervisor — Tiara">
        <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">
          Halaman ini hanya untuk admin.
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Supervisor — Tiara">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Supervisor — Agent Performance</h1>
          <span className="text-xs text-slate-500">Update tiap 60 detik</span>
        </div>

        {list.error && <div className="text-sm text-rose-600">Gagal memuat: {list.error.message}</div>}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Agent</th>
                <th className="px-3 py-2 text-left">Tier (today)</th>
                <th className="px-3 py-2 text-right">Score</th>
                <th className="px-3 py-2 text-right">7d Avg</th>
                <th className="px-3 py-2">Trend</th>
                <th className="px-3 py-2 text-right">Conv</th>
                <th className="px-3 py-2 text-right">Conv Rate</th>
                <th className="px-3 py-2 text-right">Open Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(list.data?.items || []).map((a) => (
                <tr key={a.staff_id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <Link href={`/supervisor/${a.staff_id}`} className="text-brand-700 hover:underline font-medium">
                      {a.full_name || a.username}
                    </Link>
                    <div className="text-xs text-slate-400">@{a.username} · {a.role}</div>
                  </td>
                  <td className="px-3 py-2"><PerformanceTierPill score={a.today_score} /></td>
                  <td className="px-3 py-2 text-right text-sm">
                    {a.today_score != null ? Number(a.today_score).toFixed(0) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-sm text-slate-500">
                    {a.avg7d_score != null ? Number(a.avg7d_score).toFixed(0) : '—'}
                  </td>
                  <td className="px-3 py-2"><Sparkline series={a.series7d} /></td>
                  <td className="px-3 py-2 text-right text-sm">{a.conv_handled || 0}</td>
                  <td className="px-3 py-2 text-right text-sm">
                    {a.conversion_rate != null ? `${Math.round(a.conversion_rate * 100)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {a.open_flags > 0
                      ? <span className="text-xs px-2 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">{a.open_flags}</span>
                      : <span className="text-xs text-slate-400">0</span>}
                  </td>
                </tr>
              ))}
              {list.data?.items?.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">Belum ada data agent</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
```

- [ ] **Step 2: Add "Supervisor" link in `Layout.jsx`**

```bash
grep -n "href=\"/users\"\|href=\"/ai-settings\"\|href=\"/inbox\"" /home/krttpt/crm/frontend/src/components/Layout.jsx | head -5
```

Locate the existing nav link block. Add a Supervisor link right next to other admin-only items, conditional on user role:

```jsx
{isAdmin && (
  <Link href="/supervisor" className="...same classes as other links...">Supervisor</Link>
)}
```

(Adapt `isAdmin` boolean to however the layout currently checks role — search the file for `role === 'admin'` patterns.)

- [ ] **Step 3: Build**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -10
```

Expected: build PASS, `/supervisor` route shown in route list.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/supervisor/index.js frontend/src/components/Layout.jsx
git commit -m "feat(supervisor): /supervisor agent table page + nav link

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `/supervisor/[staffId]` drilldown page

**Files:**
- Create: `frontend/src/pages/supervisor/[staffId].js`

- [ ] **Step 1: Write the page**

```jsx
// frontend/src/pages/supervisor/[staffId].js
import { useRouter } from 'next/router';
import { useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';
import PerformanceTierPill from '@/components/PerformanceTierPill';
import RedFlagBadge from '@/components/RedFlagBadge';
import { formatRelative } from '@/lib/format';

export default function SupervisorAgent() {
  const toast = useToast();
  const router = useRouter();
  const { staffId } = router.query;
  const me = useSWR('/api/auth/me', fetcher);
  const data = useSWR(staffId ? `/api/supervisor/agents/${staffId}` : null, fetcher, { refreshInterval: 60_000 });
  const [filter, setFilter] = useState('open'); // open|all
  const [resolveId, setResolveId] = useState(null);
  const [note, setNote] = useState('');

  if (me.data && me.data.user?.role !== 'admin') {
    return <Layout title="Supervisor"><div className="p-12 text-center text-rose-600">Admin only</div></Layout>;
  }

  const staff = data.data?.staff;
  const scores = data.data?.scores || [];
  const flags = data.data?.flags || [];
  const sug = data.data?.suggestion_stats || [];
  const todayScore = scores.find((s) => s.date === new Date().toISOString().slice(0, 10))?.performance_score;
  const filteredFlags = filter === 'open' ? flags.filter((f) => !f.resolved_at) : flags;

  async function resolve(id) {
    try {
      await api(`/api/supervisor/flags/${id}/resolve`, { method: 'POST', body: { note } });
      toast.success('Flag resolved');
      setResolveId(null); setNote('');
      data.mutate();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <Layout title={staff ? `${staff.full_name || staff.username} — Supervisor` : 'Supervisor'}>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/supervisor" className="text-sm text-slate-500 hover:underline">← All agents</Link>
        </div>

        {staff && (
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-slate-800">{staff.full_name || staff.username}</h1>
              <div className="text-xs text-slate-500 mt-1">@{staff.username} · {staff.role}
                {staff.last_login_at && <> · last login {formatRelative(staff.last_login_at)}</>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <PerformanceTierPill score={todayScore} showScore />
            </div>
          </div>
        )}

        {/* Score history (last 30d) */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Score history (last {scores.length} days)</h2>
          {scores.length === 0
            ? <div className="text-sm text-slate-400">Belum ada data score</div>
            : <table className="w-full text-xs">
                <thead className="text-slate-500 uppercase">
                  <tr>
                    <th className="text-left py-1">Date</th>
                    <th className="text-right py-1">Score</th>
                    <th className="text-right py-1">Conv</th>
                    <th className="text-right py-1">Won/Lost</th>
                    <th className="text-right py-1">Avg Resp (s)</th>
                    <th className="text-right py-1">Sug Used %</th>
                    <th className="text-right py-1">Flags H/C</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {scores.slice(0, 30).map((s) => {
                    const sugUsedPct = s.suggestion_shown > 0
                      ? Math.round(((s.suggestion_used_raw + s.suggestion_used_edited) / s.suggestion_shown) * 100)
                      : null;
                    return (
                      <tr key={s.date} className="hover:bg-slate-50">
                        <td className="py-1">{s.date}</td>
                        <td className="text-right py-1 font-medium">{s.performance_score != null ? Number(s.performance_score).toFixed(0) : '—'}</td>
                        <td className="text-right py-1">{s.conv_handled}</td>
                        <td className="text-right py-1">{s.conv_closed_won}/{s.conv_closed_lost}</td>
                        <td className="text-right py-1">{s.avg_response_time_sec || '—'}</td>
                        <td className="text-right py-1">{sugUsedPct != null ? sugUsedPct + '%' : '—'}</td>
                        <td className="text-right py-1">{s.red_flags_high}/{s.red_flags_critical}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>}
        </div>

        {/* Red flags */}
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-700">Red flags ({filteredFlags.length})</h2>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}
              className="text-xs px-2 py-1 border border-slate-200 rounded">
              <option value="open">Open only</option>
              <option value="all">All</option>
            </select>
          </div>
          {filteredFlags.length === 0
            ? <div className="text-sm text-slate-400">No flags</div>
            : <ul className="divide-y divide-slate-100">
                {filteredFlags.map((f) => (
                  <li key={f.id} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <RedFlagBadge severity={f.severity} size="xs" />
                          <span className="font-medium text-slate-800">{f.rule_id}</span>
                          {f.conversation_id && (
                            <Link href={`/inbox/${f.conversation_id}`}
                              className="text-xs text-brand-600 hover:underline">→ conv #{f.conversation_id}</Link>
                          )}
                          <span className="text-xs text-slate-400">· {formatRelative(f.detected_at)}</span>
                        </div>
                        {f.detail && Object.keys(f.detail).length > 0 && (
                          <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">
                            {JSON.stringify(f.detail)}
                          </div>
                        )}
                        {f.resolved_at && (
                          <div className="text-xs text-emerald-600 mt-0.5">
                            ✓ Resolved {formatRelative(f.resolved_at)}
                            {f.resolution_note && <span className="text-slate-500"> — {f.resolution_note}</span>}
                          </div>
                        )}
                      </div>
                      {!f.resolved_at && (
                        <button onClick={() => setResolveId(f.id)}
                          className="text-xs px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                          Resolve
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>}
        </div>

        {/* Suggestion stats */}
        {sug.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Suggestion usage</h2>
            <table className="w-full text-xs">
              <thead className="text-slate-500 uppercase">
                <tr>
                  <th className="text-left py-1">Day</th>
                  <th className="text-right py-1">Shown</th>
                  <th className="text-right py-1">Raw</th>
                  <th className="text-right py-1">Edited</th>
                  <th className="text-right py-1">Manual</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sug.map((s) => (
                  <tr key={s.day}>
                    <td className="py-1">{s.day}</td>
                    <td className="text-right py-1">{s.shown}</td>
                    <td className="text-right py-1">{s.used_raw}</td>
                    <td className="text-right py-1">{s.used_edited}</td>
                    <td className="text-right py-1">{s.manual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Resolve modal */}
      {resolveId && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50" onClick={() => setResolveId(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4 m-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-slate-800 mb-2">Resolve red flag</h3>
            <textarea value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Catatan resolusi (opsional)…"
              rows={3}
              className="w-full text-sm border border-slate-200 rounded p-2 mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setResolveId(null); setNote(''); }}
                className="text-sm px-3 py-1.5 rounded border border-slate-200">Cancel</button>
              <button onClick={() => resolve(resolveId)}
                className="text-sm px-3 py-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600">
                Mark resolved
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
```

- [ ] **Step 2: Build + restart**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -10
pm2 restart crm-pilot-frontend && sleep 3
```

Expected: route `/supervisor/[staffId]` listed in build output.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/supervisor/\[staffId\].js
git commit -m "feat(supervisor): /supervisor/[staffId] drilldown — flags + scores + resolve modal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: E2E smoke verification

- [ ] **Step 1: Inject a synthetic red flag (force flagged_suggestion)**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "UPDATE crm_suggestion_log SET flagged_reason='harmful', staff_id=COALESCE(staff_id, 1) WHERE id = (SELECT id FROM crm_suggestion_log ORDER BY id DESC LIMIT 1) RETURNING id, staff_id, flagged_reason;"
```

- [ ] **Step 2: Run real-time detector and confirm a row appears**

```bash
cd /home/krttpt/crm && node backend/scripts/redFlagRealtime.js 2>&1 | tail -3
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT id, staff_id, rule_id, severity, detected_at FROM crm_agent_red_flags ORDER BY id DESC LIMIT 3;"
```

Expected: at least one row with `rule_id='flagged_suggestion'`, `severity='low'`.

- [ ] **Step 3: Run batch detector**

```bash
cd /home/krttpt/crm && node backend/scripts/missedFollowup.js 2>&1 | tail -3
```

Expected: log line, no errors.

- [ ] **Step 4: Run nightly aggregator and verify a row**

```bash
cd /home/krttpt/crm && node backend/scripts/scoreAggregatorCron.js 2>&1 | tail -3
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "SELECT staff_id, date, conv_handled, performance_score FROM crm_agent_daily_scores WHERE date >= current_date - interval '1 day' ORDER BY staff_id, date;"
```

Expected: rows for active staff for today / yesterday with `performance_score` populated (0-100).

- [ ] **Step 5: API smoke (auth gate)**

```bash
for ep in /agents /agents/1 /flags/1/resolve; do
  curl -s -o /dev/null -w "%{http_code} $ep\n" "http://localhost:3009/api/supervisor$ep"
done
```

Expected: all `401` (auth required).

- [ ] **Step 6: Verify cron entries installed**

```bash
grep -E "redFlagRealtime|missedFollowup|scoreAggregatorCron" /etc/cron.d/crm-pilot
```

Expected: 3 lines.

- [ ] **Step 7: Resolve the synthetic flag**

```bash
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "UPDATE crm_agent_red_flags SET resolved_at=now(), resolution_note='smoke cleanup' WHERE rule_id='flagged_suggestion' AND resolved_at IS NULL;"
PGPASSWORD='VonageSync2026!' psql -h localhost -U vonage_sync -d vonage_reports -c \
  "UPDATE crm_suggestion_log SET flagged_reason=NULL WHERE flagged_reason='harmful' AND id = (SELECT MAX(id) FROM crm_suggestion_log);"
```

- [ ] **Step 8: Final commit (test fixes if any)**

```bash
git status
# If no changes: skip
git add -A
git commit -m "test(supervisor): phase 3 e2e smoke verified"
```

---

## Acceptance Criteria Mapping (spec §5)

| Spec § | Verified by |
|---|---|
| §5.1 11 rules (10 implementable; discount_unauthorized deferred) | Task 3 + Task 4 + Task 5 |
| §5.2 composite formula | Task 6 |
| §5.3 tier mapping | Task 9 (PerformanceTierPill.tierFor) |
| §5.4 cron jobs (1-min, 5-min, nightly) | Tasks 4, 5, 7 |
| §5.5 critical → Telegram | Task 4 (notifyCritical) |
| §5.5 high → batched digest | Deferred to Phase 4 (Phase 3 only does critical push + dashboard) |
| §5.6 supervisor dashboard table + drilldown + resolve | Tasks 10, 11, plus Task 8 endpoints |

---

## Operational Notes

- **`discount_unauthorized` rule deferred** — requires `crm_promos` table (not in current schema). When promo system is added, append a `ruleDiscountUnauthorized()` to `redFlagDetector.js` and include it in `evaluateBatch()`.
- **High-severity batched digest deferred** — Phase 3 only sends critical alerts in real-time. A future Phase 4 task can add an hourly `redFlagDigest.js` cron that summarizes `severity='high'` flags into one Telegram message.
- **Coach mode tags ("1-on-1 scheduled")** — spec §5.6 mentions these; not implemented in Phase 3 to keep scope tight. Easy follow-up: add a `crm_agent_coaching_notes` table + small UI on drilldown.
- **PII rule is conservative** — only flags Indonesian-shaped phone numbers in operator outbound. Email/NIK/KTP detection are easy to add to `rulePiiLeak()` in a follow-up.
- **Score formula tuning** — review distribution after 2 weeks. If everyone clusters in "Solid", the bonuses are too generous; if everyone is "Coaching", penalties are too harsh.
