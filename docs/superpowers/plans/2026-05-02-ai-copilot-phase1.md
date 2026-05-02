# AI Co-Pilot Phase 1 — Mode Toggle + Suggestion Engine + UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation of Co-Pilot Mode — admin can toggle global `ai_mode`, and when set to `copilot`, AI generates 4 suggestions per inbound (3 case-library + 1 AI synthesis) shown in chat detail UI for operator pick/edit/send.

**Architecture:** Branch in `aiAgent.processOne()` by `crm_settings.ai_mode`. New `suggestionEngine` service runs case-library SQL + Claude haiku elaboration in parallel, persists to `crm_suggestion_log`, emits socket event. Frontend adds `<CoPilotPanel>` above composer in `/inbox/[id]`, plus radio toggle in `/ai-settings`.

**Tech Stack:** Node 20 + Express 5, PostgreSQL (pg), Claude Anthropic SDK (`claude-haiku-4-5`), socket.io, Next.js 14 + Tailwind v3 + SWR.

**Spec reference:** `docs/specs/2026-05-02-ai-copilot-supervisor-design.md` sections 1-4.

**Out of scope (Phase 2/3):** Lead temperature classifier, supervisor scoring, red flag detection, supervisor dashboard.

---

## File Map

**Backend create:**
- `backend/migrations/015_copilot.sql` — schema for Phase 1 (settings, templates extension, suggestion_log, response timing columns; full migration also includes Phase 2/3 tables — written all at once so we don't need 015b/015c later)
- `backend/services/suggestionEngine.js` — generate 4 options (3 case + 1 AI), persist log
- `backend/services/caseLibrary.js` — relevance-ranked SQL lookup against `crm_reply_templates`
- `backend/routes/suggestions.js` — REST endpoints (latest, regenerate, use, flag)

**Backend modify:**
- `backend/services/aiAgent.js` — add `ai_mode` branch in `processOne()` (call suggestionEngine instead of generateReply when copilot)
- `backend/server.js` (or main router file) — mount `/api/conversations/:id/suggestions` router
- `backend/migrations/002_seed_persona.sql` patterns reference for seeding cases

**Frontend create:**
- `frontend/src/components/CoPilotPanel.jsx` — 4 suggestion cards + use/regenerate/flag actions, keyboard shortcuts, socket sync
- `frontend/src/lib/socket.js` — extend with `suggestion:new` / `suggestion:used` event helpers (or inline in component if minimal)

**Frontend modify:**
- `frontend/src/pages/inbox/[id].js` — render `<CoPilotPanel>` when `ai_mode === 'copilot'` and inbound msg present
- `frontend/src/pages/ai-settings.js` — add Mode toggle card at top
- `frontend/src/lib/format.js` — no changes needed (just for reference)

**Seed data:**
- Insert ~10 starter `crm_reply_templates` rows with `case_label` + `case_pattern` + `intent_match` populated, covering top intents (greeting, pricing, shipping, order_status, ongkir, closing CTA, ask-clarify, escalate-prompt fallbacks).

---

## Task 1: Migration `015_copilot.sql`

**Files:**
- Create: `backend/migrations/015_copilot.sql`

- [ ] **Step 1: Write migration file**

```sql
-- 015_copilot.sql — AI Co-Pilot mode + supervisor scoring + lead temperature
BEGIN;

-- ============ Phase 1 ============
INSERT INTO crm_settings (key, value)
VALUES ('ai_mode', '"auto"'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO crm_settings (key, value) VALUES
  ('first_response_sla_seconds', '60'::jsonb),
  ('followup_sop_minutes', '30'::jsonb),
  ('suggestion_deviation_threshold', '0.3'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE crm_reply_templates
  ADD COLUMN IF NOT EXISTS case_label   varchar(80),
  ADD COLUMN IF NOT EXISTS case_pattern text,
  ADD COLUMN IF NOT EXISTS intent_match varchar(32);

CREATE TABLE IF NOT EXISTS crm_suggestion_log (
  id              bigserial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  inbound_msg_id  bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  shown_at        timestamptz DEFAULT now(),
  options         jsonb NOT NULL,
  generation_ms   int,
  picked_rank     smallint,
  usage_type      varchar(10),
  sent_msg_id     bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  staff_id        int,
  pick_latency_ms int,
  edit_distance   numeric(4,3),
  flagged_reason  varchar(20),
  flagged_note    text,
  regen_count     smallint DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_suggestion_log_conv ON crm_suggestion_log (conversation_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestion_log_staff ON crm_suggestion_log (staff_id, shown_at DESC) WHERE staff_id IS NOT NULL;

-- ============ Phase 2 (lead temp) ============
ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS first_inbound_at  timestamptz,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS lead_temperature  varchar(8) DEFAULT 'cold',
  ADD COLUMN IF NOT EXISTS lead_score        smallint;
CREATE INDEX IF NOT EXISTS idx_conv_lead_temp ON crm_conversations (lead_temperature, last_message_at DESC);

-- ============ Phase 3 (scoring) ============
CREATE TABLE IF NOT EXISTS crm_agent_red_flags (
  id              bigserial PRIMARY KEY,
  staff_id        int NOT NULL,
  conversation_id int,
  rule_id         varchar(40) NOT NULL,
  severity        varchar(10) NOT NULL,
  detail          jsonb,
  detected_at     timestamptz DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     int,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS idx_red_flags_staff ON crm_agent_red_flags (staff_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_red_flags_open  ON crm_agent_red_flags (severity, resolved_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS crm_agent_daily_scores (
  staff_id              int NOT NULL,
  date                  date NOT NULL,
  conv_handled          int DEFAULT 0,
  msg_sent              int DEFAULT 0,
  avg_response_time_sec int,
  suggestion_shown      int DEFAULT 0,
  suggestion_used_raw   int DEFAULT 0,
  suggestion_used_edited int DEFAULT 0,
  suggestion_manual     int DEFAULT 0,
  avg_edit_distance     numeric(4,3),
  conv_closed_won       int DEFAULT 0,
  conv_closed_lost      int DEFAULT 0,
  total_value_won       numeric(14,2),
  conversion_rate       numeric(4,3),
  red_flags_high        int DEFAULT 0,
  red_flags_critical    int DEFAULT 0,
  csat_avg              numeric(3,2),
  csat_count            int DEFAULT 0,
  performance_score     numeric(5,2),
  computed_at           timestamptz DEFAULT now(),
  PRIMARY KEY (staff_id, date)
);

COMMIT;
```

- [ ] **Step 2: Apply migration**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -f backend/migrations/015_copilot.sql
```

Expected: `BEGIN ... INSERT 0 1 ... ALTER TABLE ... CREATE TABLE ... COMMIT`

- [ ] **Step 3: Verify schema**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c "\d crm_suggestion_log" \
  -c "\d crm_agent_red_flags" \
  -c "SELECT key, value FROM crm_settings WHERE key IN ('ai_mode','first_response_sla_seconds','followup_sop_minutes','suggestion_deviation_threshold');"
```

Expected: tables present; settings show `ai_mode = "auto"`, sla=60, followup=30, threshold=0.3.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/015_copilot.sql
git commit -m "feat(db): migration 015 — copilot mode, suggestion log, scoring, lead temp"
```

---

## Task 2: Seed starter case-library templates

**Files:**
- Create: `backend/migrations/016_seed_copilot_cases.sql`

- [ ] **Step 1: Write seed file**

```sql
-- 016_seed_copilot_cases.sql — starter case library for copilot mode
BEGIN;

INSERT INTO crm_reply_templates (shortcut, title, body, enabled, category, case_label, case_pattern, intent_match) VALUES
('greeting_default',
 'Greeting awal',
 'Halo Kak 🌷 terima kasih sudah chat Prestisa. Ada yang bisa Tiara bantu? Mau cari bunga papan, bouquet, parsel, atau cake?',
 TRUE, 'copilot', 'Greeting awal', '\y(halo|hai|hi|assalam|pagi|siang|sore|malam)\y', 'greeting'),

('ask_clarify',
 'Minta detail order',
 'Boleh Kak share detailnya: untuk siapa, kapan dikirim, dan ke kota mana ya? Biar Tiara bisa siapkan rekomendasi yang pas 🙏',
 TRUE, 'copilot', 'Minta detail order', '\y(mau|cari|butuh|order|pesan)\y', 'product_info'),

('escalate_default',
 'Escalate fallback',
 'Sebentar ya Kak, Tiara hubungkan dengan tim spesialis untuk pastikan info lebih detail 🙏',
 TRUE, 'copilot', 'Escalate fallback', NULL, NULL),

('pricing_general',
 'Tanya harga umum',
 'Range harga kami Kak: bunga papan mulai Rp 350rb, bouquet mulai Rp 150rb, parsel mulai Rp 250rb, cake mulai Rp 200rb. Boleh Tiara kirimkan pilihan sesuai budget Kakak?',
 TRUE, 'copilot', 'Tanya harga umum', '\y(harga|berapa|murah|budget|anggaran)\y', 'pricing'),

('shipping_jabodetabek',
 'Tanya ongkir',
 'Untuk area Jabodetabek free ongkir Kak ✨ luar Jabodetabek mulai Rp 50rb tergantung kota. Mau kirim ke kota mana?',
 TRUE, 'copilot', 'Tanya ongkir', '\y(ongkir|ongkos|kirim|delivery|pengiriman)\y', 'shipping'),

('order_status_check',
 'Cek status order',
 'Boleh Tiara bantu cek Kak. Mohon share nomor order atau nomor HP yang dipakai saat order ya 🙏',
 TRUE, 'copilot', 'Cek status order', '\y(status|order|pesanan|sudah sampai|kapan sampai|tracking)\y', 'order_status'),

('closing_cta',
 'Closing CTA',
 'Mau Tiara siapkan link order dengan pilihan tadi Kak? Tinggal isi alamat & jadwal kirim, langsung diproses tim kami ✅',
 TRUE, 'copilot', 'Closing CTA', NULL, 'order_intent'),

('payment_info',
 'Info pembayaran',
 'Setelah submit order, sistem otomatis kasih nomor VA / rekening transfer ya Kak. Pembayaran terkonfirmasi → langsung diproses ✨',
 TRUE, 'copilot', 'Info pembayaran', '\y(bayar|payment|transfer|rekening|VA|virtual account)\y', 'payment'),

('lead_time_default',
 'Lead time produksi',
 'Untuk pengerjaan butuh sekitar 3-6 jam Kak setelah pembayaran terkonfirmasi. Untuk hari spesial seperti besok pagi, sebaiknya order H-1 ya 🙏',
 TRUE, 'copilot', 'Lead time produksi', '\y(jam|kapan jadi|berapa lama|lama proses)\y', 'shipping'),

('out_of_area_polite',
 'Area di luar coverage',
 'Maaf Kak, untuk area itu Tiara cek dulu ketersediaan kurirnya ya. Sebentar 🙏',
 TRUE, 'copilot', 'Area di luar coverage', NULL, 'shipping')

ON CONFLICT (shortcut) DO UPDATE SET
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  case_label = EXCLUDED.case_label,
  case_pattern = EXCLUDED.case_pattern,
  intent_match = EXCLUDED.intent_match;

COMMIT;
```

- [ ] **Step 2: Apply seed**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -f backend/migrations/016_seed_copilot_cases.sql
```

Expected: `BEGIN ... INSERT 0 10 ... COMMIT`

- [ ] **Step 3: Verify**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT shortcut, case_label, intent_match FROM crm_reply_templates WHERE case_label IS NOT NULL ORDER BY id;"
```

Expected: 10 rows printed.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/016_seed_copilot_cases.sql
git commit -m "feat(db): seed 10 starter case-library templates for copilot"
```

---

## Task 3: `caseLibrary.js` service — relevance-ranked lookup

**Files:**
- Create: `backend/services/caseLibrary.js`

- [ ] **Step 1: Write the service**

```js
// backend/services/caseLibrary.js
// Relevance-ranked case-library lookup. Returns up to 3 templates,
// padded with fallback if fewer matches found.
const pg = require('../db/postgres');

const FALLBACK_SHORTCUTS = ['greeting_default', 'ask_clarify', 'escalate_default'];

async function lookup({ inboundBody, intent }) {
  const body = String(inboundBody || '').slice(0, 2000);
  const intentLabel = intent || null;
  const r = await pg.query(
    `SELECT id, shortcut, body, case_label, intent_match,
       (
         CASE WHEN intent_match = $1 THEN 50 ELSE 0 END +
         CASE WHEN $1 IS NOT NULL AND case_pattern IS NOT NULL AND $2 ~* case_pattern THEN 30
              WHEN case_pattern IS NOT NULL AND $2 ~* case_pattern THEN 30
              ELSE 0 END +
         GREATEST(0, 20 - EXTRACT(EPOCH FROM (now() - updated_at))::int / 86400 / 30)
       ) AS relevance
     FROM crm_reply_templates
     WHERE enabled = TRUE AND case_label IS NOT NULL
     ORDER BY relevance DESC, id ASC
     LIMIT 6`,
    [intentLabel, body]
  );
  const ranked = r.rows.filter((row) => Number(row.relevance) >= 30).slice(0, 3);
  if (ranked.length >= 3) return { items: ranked, lowConfidence: false };

  // Pad with fallbacks (skip duplicates by shortcut)
  const used = new Set(ranked.map((x) => x.shortcut));
  const fb = await pg.query(
    `SELECT id, shortcut, body, case_label, intent_match
     FROM crm_reply_templates
     WHERE shortcut = ANY($1) AND enabled = TRUE`,
    [FALLBACK_SHORTCUTS]
  );
  for (const f of fb.rows) {
    if (ranked.length >= 3) break;
    if (!used.has(f.shortcut)) {
      ranked.push({ ...f, relevance: 0 });
      used.add(f.shortcut);
    }
  }
  return { items: ranked.slice(0, 3), lowConfidence: true };
}

module.exports = { lookup };
```

- [ ] **Step 2: Smoke test**

```bash
cd /home/krttpt/crm && node -e "
require('dotenv').config({ path: '.env' });
(async () => {
  const lib = require('./backend/services/caseLibrary');
  const a = await lib.lookup({ inboundBody: 'berapa harga bouquet?', intent: 'pricing' });
  console.log('PRICING:', a.lowConfidence, a.items.map(x => x.shortcut));
  const b = await lib.lookup({ inboundBody: 'asdf qwerty zzz', intent: null });
  console.log('NONSENSE:', b.lowConfidence, b.items.map(x => x.shortcut));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
```

Expected:
```
PRICING: false [ 'pricing_general', ... ]
NONSENSE: true [ 'greeting_default', 'ask_clarify', 'escalate_default' ]
```

- [ ] **Step 3: Commit**

```bash
git add backend/services/caseLibrary.js
git commit -m "feat(copilot): caseLibrary — relevance-ranked template lookup"
```

---

## Task 4: `suggestionEngine.js` service — generate 4 options + persist

**Files:**
- Create: `backend/services/suggestionEngine.js`

- [ ] **Step 1: Write the service**

```js
// backend/services/suggestionEngine.js
// Generate 4 reply suggestions for an inbound message:
//   - 3 from case library (relevance-ranked)
//   - 1 AI synthesis via Claude haiku (alt phrasing / CTA)
// Persist to crm_suggestion_log, return options + log id.
const pg = require('../db/postgres');
const caseLibrary = require('./caseLibrary');
const claude = require('./claudeClient');
const persona = require('./aiPersona');
const logger = require('./logger');

const AI_MODEL = process.env.COPILOT_AI_MODEL || 'claude-haiku-4-5';
const AI_TIMEOUT_MS = parseInt(process.env.COPILOT_AI_TIMEOUT_MS) || 4000;

async function lastTurns(conversationId, limit = 5) {
  const r = await pg.query(
    `SELECT direction, sender_type, body, created_at
     FROM crm_messages
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT $2`,
    [conversationId, limit]
  );
  return r.rows.reverse();
}

function buildAiPrompt({ inboundBody, intent, intentConf, turns, caseOptions }) {
  const transcript = turns.map((t) =>
    `${t.direction === 'in' ? 'Customer' : 'Tiara'}: ${t.body || '(media)'}`
  ).join('\n');
  const cases = caseOptions.map((c, i) => `${i+1}. ${c.body}`).join('\n');
  return `Customer message terbaru: "${inboundBody}"
Intent: ${intent || 'unknown'} (confidence ${intentConf ?? '-'})

Last 5 turns:
${transcript}

3 saran reply (case library):
${cases}

Tugas: tulis 1 reply ALTERNATIF — synthesize/improve dari 3 saran di atas dengan persona Tiara.
Constraint:
- Bahasa Indonesia santai-sopan, sapaan "Kak"
- Max 200 kata
- Kalau 3 saran sudah cover semua angle, tawarkan kombinasi atau tambah CTA (mis. "Mau Tiara siapin link order Kak?")
- Output: HANYA text reply, tanpa preamble, tanpa quote marks, tanpa label.`;
}

async function generateAi({ inboundBody, intent, intentConf, turns, caseOptions }) {
  const sys = await persona.getActiveSystemPrompt().catch(() => '');
  const t0 = Date.now();
  try {
    const resp = await Promise.race([
      claude.complete({
        model: AI_MODEL,
        system: sys,
        messages: [{ role: 'user', content: buildAiPrompt({ inboundBody, intent, intentConf, turns, caseOptions }) }],
        max_tokens: 400,
        temperature: 0.4,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ai_timeout')), AI_TIMEOUT_MS)),
    ]);
    const text = (resp?.text || '').trim();
    return { text, ms: Date.now() - t0, error: null };
  } catch (err) {
    logger.warn({ err: err.message }, '[suggestion] ai elaboration failed');
    return { text: null, ms: Date.now() - t0, error: err.message };
  }
}

/**
 * @param {{conversationId:number, inboundMsgId:number, inboundBody:string,
 *          intent?:string, intentConf?:number, regen?:boolean, regenLogId?:number}} opts
 */
async function generate(opts) {
  const { conversationId, inboundMsgId, inboundBody, intent, intentConf, regen, regenLogId } = opts;
  const t0 = Date.now();

  const [{ items: caseItems, lowConfidence }, turns] = await Promise.all([
    caseLibrary.lookup({ inboundBody, intent }),
    lastTurns(conversationId, 5),
  ]);

  const aiResult = await generateAi({ inboundBody, intent, intentConf, turns, caseOptions: caseItems });

  const options = caseItems.map((c, i) => ({
    rank: i + 1,
    source: 'case',
    template_id: c.id,
    template_shortcut: c.shortcut,
    case_label: c.case_label,
    text: c.body,
    confidence: lowConfidence ? 'low' : 'normal',
  }));
  options.push({
    rank: 4,
    source: aiResult.text ? 'ai' : 'fallback',
    text: aiResult.text || 'Tidak ada usulan AI — gunakan opsi 1-3 atau ketik manual.',
    confidence: aiResult.text ? (lowConfidence ? 'low' : 'normal') : 'low',
    ai_ms: aiResult.ms,
    ai_error: aiResult.error,
  });

  const generationMs = Date.now() - t0;

  let logId;
  if (regen && regenLogId) {
    const r = await pg.query(
      `UPDATE crm_suggestion_log
       SET options = $1, generation_ms = $2, shown_at = now(),
           regen_count = regen_count + 1
       WHERE id = $3 RETURNING id`,
      [JSON.stringify(options), generationMs, regenLogId]
    );
    logId = r.rows[0]?.id;
  } else {
    const r = await pg.query(
      `INSERT INTO crm_suggestion_log
         (conversation_id, inbound_msg_id, options, generation_ms)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [conversationId, inboundMsgId, JSON.stringify(options), generationMs]
    );
    logId = r.rows[0].id;
  }

  return {
    log_id: logId,
    options,
    generation_ms: generationMs,
    low_confidence_warning: lowConfidence,
  };
}

module.exports = { generate };
```

- [ ] **Step 2: Verify claudeClient interface**

```bash
grep -n "module.exports\|exports\." /home/krttpt/crm/backend/services/claudeClient.js | head -10
```

If `claude.complete` does not exist, adapt to actual exported name (likely `chat` or `generate`). Update Step 1 code accordingly before continuing.

- [ ] **Step 3: Smoke test (without AI — uses real DB conv)**

```bash
cd /home/krttpt/crm && node -e "
require('dotenv').config({ path: '.env' });
(async () => {
  const pg = require('./backend/db/postgres');
  const conv = await pg.query(\"SELECT id FROM crm_conversations ORDER BY last_message_at DESC NULLS LAST LIMIT 1\");
  const msg = await pg.query(\"SELECT id, body FROM crm_messages WHERE conversation_id = \$1 AND direction='in' ORDER BY id DESC LIMIT 1\", [conv.rows[0].id]);
  if (!msg.rows[0]) { console.log('no inbound msg'); process.exit(0); }
  const eng = require('./backend/services/suggestionEngine');
  const r = await eng.generate({
    conversationId: conv.rows[0].id,
    inboundMsgId: msg.rows[0].id,
    inboundBody: msg.rows[0].body,
    intent: 'pricing',
  });
  console.log(JSON.stringify({ log_id: r.log_id, ms: r.generation_ms, low: r.low_confidence_warning,
    sources: r.options.map(o => o.source), ai_text_len: r.options[3]?.text?.length }, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected: `log_id` numeric, `ms` < 5000, 4 options with sources `['case','case','case','ai'|'fallback']`.

- [ ] **Step 4: Commit**

```bash
git add backend/services/suggestionEngine.js
git commit -m "feat(copilot): suggestionEngine — 4 options (3 case + 1 AI synthesis)"
```

---

## Task 5: Branch `aiAgent.processOne()` by `ai_mode`

**Files:**
- Modify: `backend/services/aiAgent.js`

- [ ] **Step 1: Read current processOne**

```bash
grep -n "async function processOne\|module.exports\|ai_paused\|ai_enabled\|generateReply\|getSetting" /home/krttpt/crm/backend/services/aiAgent.js | head -30
```

Note the location of the existing reply-generation call. The branch goes immediately after spam/handover/paused checks, **before** the reply generation.

- [ ] **Step 2: Add settings + suggestionEngine import at top of aiAgent.js**

```js
const settings = require('./settings');
const suggestionEngine = require('./suggestionEngine');
```

(Skip if already imported.)

- [ ] **Step 3: Insert mode branch in processOne**

After the existing checks that confirm we should reply (ai_enabled, not paused, not handover), and after intent classification has produced `intent` + `intentConf` for this turn, insert:

```js
// Mode branch — co-pilot generates suggestions instead of sending.
const aiMode = await settings.getSetting('ai_mode', 'auto');
if (aiMode === 'copilot') {
  try {
    const result = await suggestionEngine.generate({
      conversationId: conv.id,
      inboundMsgId: msg.id,                 // adjust var name to actual
      inboundBody: msg.body,                // adjust var name to actual
      intent: intent || null,
      intentConf: intentConf ?? null,
    });
    const io = require('../app').getIo?.() || global.__io;
    if (io) {
      io.to(`crm:conv:${conv.id}`).emit('suggestion:new', {
        conversation_id: conv.id,
        log_id: result.log_id,
        options: result.options,
        generation_ms: result.generation_ms,
        low_confidence_warning: result.low_confidence_warning,
      });
    }
    logger.info({ conv_id: conv.id, log_id: result.log_id, ms: result.generation_ms }, '[copilot] suggestions generated');
  } catch (err) {
    logger.error({ err: err.message, conv_id: conv.id }, '[copilot] generate failed');
  }
  return; // do NOT proceed to auto-reply
}
// existing auto-reply path continues below
```

(If the worker's io accessor differs, use the existing pattern from this file. Search `io.to` or `io.emit` in aiAgent.js to copy the same accessor.)

- [ ] **Step 4: Smoke test — toggle copilot, send test inbound**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c "UPDATE crm_settings SET value = '\"copilot\"'::jsonb WHERE key = 'ai_mode';"
```

Then send a test inbound to your dev WAHA and watch backend logs:

```bash
pm2 logs crm-backend --lines 50 | grep -E "copilot|suggestion"
```

Expected: log line `[copilot] suggestions generated` with `log_id` + `ms`. Verify no outbound msg in `crm_messages` with `sender_type='ai'` for this turn:

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, conversation_id, sender_type, body FROM crm_messages WHERE created_at > now() - interval '2 minutes' ORDER BY id DESC LIMIT 10;"
```

Expected: latest in-bound visible, no new ai-sender out-bound for this conv.

- [ ] **Step 5: Verify suggestion_log row**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, conversation_id, generation_ms, jsonb_array_length(options) FROM crm_suggestion_log ORDER BY id DESC LIMIT 3;"
```

Expected: latest row exists, `jsonb_array_length = 4`.

- [ ] **Step 6: Reset mode to auto for now**

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c "UPDATE crm_settings SET value = '\"auto\"'::jsonb WHERE key = 'ai_mode';"
```

- [ ] **Step 7: Commit**

```bash
git add backend/services/aiAgent.js
git commit -m "feat(copilot): branch aiAgent by ai_mode — copilot generates suggestions"
```

---

## Task 6: Suggestion REST API

**Files:**
- Create: `backend/routes/suggestions.js`
- Modify: main router (likely `backend/server.js` or `backend/app.js`) to mount

- [ ] **Step 1: Locate main router mount file**

```bash
grep -rn "app.use(.*api/conversations\|app.use(.*routes/" /home/krttpt/crm/backend/ --include="*.js" | head -10
```

Note the file (likely `backend/server.js`).

- [ ] **Step 2: Write `backend/routes/suggestions.js`**

```js
// backend/routes/suggestions.js
// REST endpoints untuk co-pilot suggestion lifecycle.
const express = require('express');
const pg = require('../db/postgres');
const suggestionEngine = require('../services/suggestionEngine');
const { requireAuth } = require('../middleware/auth');
const router = express.Router({ mergeParams: true });

router.use(requireAuth);

// GET latest suggestion for a conversation (most recent inbound)
router.get('/latest', async (req, res) => {
  const convId = parseInt(req.params.id);
  if (!Number.isFinite(convId)) return res.status(400).json({ error: 'bad_conv_id' });
  const r = await pg.query(
    `SELECT id, options, generation_ms, shown_at, picked_rank, usage_type, regen_count
     FROM crm_suggestion_log
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  if (!r.rows[0]) return res.json({ suggestion: null });
  res.json({ suggestion: r.rows[0] });
});

// POST regenerate the latest suggestion (rate-limited)
router.post('/regenerate', async (req, res) => {
  const convId = parseInt(req.params.id);
  const r = await pg.query(
    `SELECT id, inbound_msg_id, regen_count FROM crm_suggestion_log
     WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  const log = r.rows[0];
  if (!log) return res.status(404).json({ error: 'no_suggestion' });
  if (log.regen_count >= 3) return res.status(429).json({ error: 'regen_limit', regen_count: log.regen_count });

  const msgQ = await pg.query(`SELECT id, body FROM crm_messages WHERE id = $1`, [log.inbound_msg_id]);
  const msg = msgQ.rows[0];
  if (!msg) return res.status(404).json({ error: 'inbound_msg_missing' });

  const out = await suggestionEngine.generate({
    conversationId: convId,
    inboundMsgId: msg.id,
    inboundBody: msg.body,
    intent: null,
    regen: true,
    regenLogId: log.id,
  });

  const io = req.app.get('io');
  if (io) io.to(`crm:conv:${convId}`).emit('suggestion:new', { conversation_id: convId, ...out });
  res.json(out);
});

// POST mark suggestion as used
router.post('/:logId/use', async (req, res) => {
  const logId = parseInt(req.params.logId);
  const { picked_rank, sent_text, sent_msg_id } = req.body || {};
  const staffId = req.user?.id || null;

  const cur = await pg.query(`SELECT options, shown_at FROM crm_suggestion_log WHERE id = $1`, [logId]);
  const log = cur.rows[0];
  if (!log) return res.status(404).json({ error: 'log_not_found' });

  let usageType = 'manual';
  let editDistance = null;
  if (picked_rank) {
    const opt = (log.options || []).find((o) => o.rank === picked_rank);
    if (opt && opt.text) {
      const d = normLevenshtein(opt.text, sent_text || '');
      editDistance = Number(d.toFixed(3));
      usageType = editDistance < 0.05 ? 'raw' : 'edited';
    }
  }
  const pickLatencyMs = Date.now() - new Date(log.shown_at).getTime();
  await pg.query(
    `UPDATE crm_suggestion_log
     SET picked_rank = $1, usage_type = $2, sent_msg_id = $3,
         staff_id = $4, pick_latency_ms = $5, edit_distance = $6
     WHERE id = $7`,
    [picked_rank || null, usageType, sent_msg_id || null, staffId, pickLatencyMs, editDistance, logId]
  );
  const io = req.app.get('io');
  const convQ = await pg.query(`SELECT conversation_id FROM crm_suggestion_log WHERE id = $1`, [logId]);
  if (io && convQ.rows[0]) {
    io.to(`crm:conv:${convQ.rows[0].conversation_id}`).emit('suggestion:used', {
      log_id: logId, picked_rank, usage_type: usageType, staff_id: staffId,
    });
  }
  res.json({ ok: true, usage_type: usageType, edit_distance: editDistance, pick_latency_ms: pickLatencyMs });
});

// POST flag suggestion
router.post('/:logId/flag', async (req, res) => {
  const logId = parseInt(req.params.logId);
  const { reason, note } = req.body || {};
  const allowed = ['off_tone', 'wrong', 'irrelevant', 'harmful'];
  if (!allowed.includes(reason)) return res.status(400).json({ error: 'bad_reason' });
  await pg.query(
    `UPDATE crm_suggestion_log SET flagged_reason = $1, flagged_note = $2 WHERE id = $3`,
    [reason, note || null, logId]
  );
  res.json({ ok: true });
});

// Normalized Levenshtein (0..1). 0 = identical, 1 = totally different.
function normLevenshtein(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  const m = a.length, n = b.length;
  if (Math.max(m, n) === 0) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n] / Math.max(m, n);
}

module.exports = router;
```

- [ ] **Step 3: Mount router**

In the main router file (from Step 1), add:

```js
const suggestionsRouter = require('./routes/suggestions');
app.use('/api/conversations/:id/suggestions', suggestionsRouter);
```

Place near other `/api/conversations/...` mounts.

- [ ] **Step 4: Restart backend + smoke test**

```bash
pm2 restart crm-backend && sleep 2
# Find a conv id with at least one suggestion log
CONV=$(psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -tAc "SELECT conversation_id FROM crm_suggestion_log ORDER BY id DESC LIMIT 1")
echo "conv=$CONV"
# Authenticated request — copy a session cookie from browser devtools first
curl -s -b "crm_session=YOUR_COOKIE" http://localhost:3001/api/conversations/$CONV/suggestions/latest | head -c 500
```

Expected: JSON with `suggestion: { id, options, generation_ms, ... }`.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/suggestions.js backend/server.js
git commit -m "feat(copilot): suggestion REST endpoints (latest/regenerate/use/flag)"
```

---

## Task 7: Frontend `<CoPilotPanel>` component

**Files:**
- Create: `frontend/src/components/CoPilotPanel.jsx`

- [ ] **Step 1: Write component**

```jsx
// frontend/src/components/CoPilotPanel.jsx
import { useEffect, useState, useCallback } from 'react';
import useSWR from 'swr';
import { api, fetcher } from '@/lib/api';
import { useToast } from '@/components/Toast';

export default function CoPilotPanel({ conversationId, onUseSuggestion, socket }) {
  const toast = useToast();
  const { data, mutate, isLoading } = useSWR(
    conversationId ? `/api/conversations/${conversationId}/suggestions/latest` : null,
    fetcher,
    { refreshInterval: 0 }
  );
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const sug = data?.suggestion;
  const opts = sug?.options || [];

  // Socket: refresh on suggestion:new / suggestion:used
  useEffect(() => {
    if (!socket || !conversationId) return;
    const onNew = (p) => { if (p.conversation_id === conversationId) mutate(); };
    const onUsed = (p) => { mutate(); };
    socket.on('suggestion:new', onNew);
    socket.on('suggestion:used', onUsed);
    return () => { socket.off('suggestion:new', onNew); socket.off('suggestion:used', onUsed); };
  }, [socket, conversationId, mutate]);

  // Keyboard shortcuts: 1-4 use, R regenerate
  useEffect(() => {
    function onKey(e) {
      if (e.target?.tagName === 'TEXTAREA' || e.target?.tagName === 'INPUT') return;
      if (['1','2','3','4'].includes(e.key)) {
        const idx = parseInt(e.key) - 1;
        if (opts[idx]) handleUse(opts[idx]);
      } else if (e.key === 'r' || e.key === 'R') {
        handleRegenerate();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts]);

  const handleUse = useCallback((opt) => {
    if (sug?.usage_type) { toast.info('Sudah digunakan operator lain'); return; }
    onUseSuggestion?.({ logId: sug.id, rank: opt.rank, text: opt.text, source: opt.source });
  }, [sug, onUseSuggestion, toast]);

  const handleRegenerate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${conversationId}/suggestions/regenerate`, { method: 'POST' });
      await mutate();
    } catch (e) {
      toast.error(e.message || 'Gagal regenerate');
    } finally {
      setBusy(false);
    }
  }, [conversationId, busy, mutate, toast]);

  const handleFlag = async (reason) => {
    if (!sug) return;
    try {
      await api(`/api/conversations/${conversationId}/suggestions/${sug.id}/flag`, {
        method: 'POST', body: { reason },
      });
      toast.success('Flag tersimpan, terima kasih');
    } catch (e) { toast.error(e.message); }
  };

  if (!conversationId) return null;
  if (isLoading) return <div className="px-3 py-2 text-xs text-slate-400">Loading suggestion…</div>;
  if (!sug) return null;

  const lowConf = opts.some((o) => o.confidence === 'low');

  return (
    <div className="border-t border-slate-200 bg-slate-50">
      <button onClick={() => setCollapsed(!collapsed)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs text-slate-600 hover:bg-slate-100">
        <span>🤖 Co-Pilot · {opts.length} suggestion · {sug.generation_ms}ms</span>
        <span>{collapsed ? '▾' : '▴'}</span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 space-y-2">
          {lowConf && (
            <div className="text-xs px-2 py-1 bg-amber-50 border border-amber-200 rounded text-amber-800">
              🔍 Konteks belum jelas — review extra hati-hati
            </div>
          )}
          {sug.usage_type && (
            <div className="text-xs px-2 py-1 bg-slate-100 border border-slate-200 rounded text-slate-600">
              ✓ Sudah digunakan: opsi #{sug.picked_rank} ({sug.usage_type})
            </div>
          )}
          {opts.map((o) => (
            <div key={o.rank}
              className={`bg-white border rounded p-2 ${sug.usage_type ? 'opacity-50' : 'border-slate-200 hover:border-brand-400'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-slate-500">
                  {o.rank}️⃣ {o.source === 'ai' ? '✨ AI' : (o.case_label || o.source)}
                </span>
                <button disabled={!!sug.usage_type} onClick={() => handleUse(o)}
                  className="text-xs px-2 py-0.5 rounded bg-brand-500 text-white disabled:bg-slate-300">
                  Use [{o.rank}]
                </button>
              </div>
              <div className="text-sm text-slate-800 whitespace-pre-wrap">{o.text}</div>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button disabled={busy} onClick={handleRegenerate}
              className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 disabled:opacity-50">
              🔄 Regenerate [R]
            </button>
            <select onChange={(e) => { if (e.target.value) handleFlag(e.target.value); e.target.value = ''; }}
              className="text-xs px-2 py-1 rounded border border-slate-300">
              <option value="">🚩 Flag…</option>
              <option value="off_tone">Off-tone</option>
              <option value="wrong">Wrong</option>
              <option value="irrelevant">Irrelevant</option>
              <option value="harmful">Harmful</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit (component standalone — wired in Task 8)**

```bash
git add frontend/src/components/CoPilotPanel.jsx
git commit -m "feat(copilot): CoPilotPanel component (4 suggestion cards + actions)"
```

---

## Task 8: Wire `<CoPilotPanel>` into `/inbox/[id]`

**Files:**
- Modify: `frontend/src/pages/inbox/[id].js`

- [ ] **Step 1: Read current page structure**

```bash
grep -n "import\|composer\|textarea\|socket\|useSWR\|onSend\|setBody\|setMessage" /home/krttpt/crm/frontend/src/pages/inbox/\[id\].js | head -50
```

Identify:
- (a) where socket instance lives,
- (b) the composer textarea state setter (probably `setDraft` or `setBody`),
- (c) where `aiMode` should be fetched from (likely `/api/settings`).

- [ ] **Step 2: Add fetch for `ai_mode` setting**

Near other SWR calls in the page:

```js
const settings = useSWR('/api/settings', fetcher);
const aiMode = settings.data?.ai_mode || 'auto';
```

Confirm that `/api/settings` exposes `ai_mode`. If not, add it to the existing settings route GET handler:

```bash
grep -rn "ai_mode\|getAllSettings\|router.get('/'" /home/krttpt/crm/backend/routes/settings.js
```

If missing, ensure the public settings endpoint returns `ai_mode` value.

- [ ] **Step 3: Render `<CoPilotPanel>` above composer**

```jsx
import CoPilotPanel from '@/components/CoPilotPanel';

// ... inside render, just above the composer textarea container:
{aiMode === 'copilot' && (
  <CoPilotPanel
    conversationId={conv?.id}
    socket={socket}
    onUseSuggestion={({ logId, rank, text, source }) => {
      setDraft(text);                       // adapt to actual setter
      // remember for sendMessage to attach metadata
      setPendingSuggestion({ logId, rank, text });
      setTimeout(() => textareaRef.current?.focus(), 0);
    }}
  />
)}
```

Add state:

```js
const [pendingSuggestion, setPendingSuggestion] = useState(null);
```

- [ ] **Step 4: After successful send, POST to `/use`**

In the existing send handler, after the message INSERT round-trip succeeds:

```js
if (pendingSuggestion) {
  api(`/api/conversations/${conv.id}/suggestions/${pendingSuggestion.logId}/use`, {
    method: 'POST',
    body: { picked_rank: pendingSuggestion.rank, sent_text: bodyThatWasSent, sent_msg_id: result?.message_id || null },
  }).catch(() => {});
  setPendingSuggestion(null);
} else {
  // manual reply path — log usage_type=manual against latest log if exists
  const latest = await fetcher(`/api/conversations/${conv.id}/suggestions/latest`).catch(() => null);
  if (latest?.suggestion?.id && !latest.suggestion.usage_type) {
    api(`/api/conversations/${conv.id}/suggestions/${latest.suggestion.id}/use`, {
      method: 'POST',
      body: { picked_rank: null, sent_text: bodyThatWasSent, sent_msg_id: result?.message_id || null },
    }).catch(() => {});
  }
}
```

- [ ] **Step 5: Build + smoke test**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors. Then:

```bash
pm2 restart crm-frontend && sleep 3
```

Open `/inbox/<some-conv-id>` in browser (after toggling `ai_mode = "copilot"` in DB). Send a test inbound. Expected: panel appears with 4 cards. Click [Use 1] → composer fills. Click Kirim → message sent + log row updated.

Verify usage:
```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, picked_rank, usage_type, edit_distance, pick_latency_ms, staff_id FROM crm_suggestion_log ORDER BY id DESC LIMIT 3;"
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/inbox/\[id\].js
git commit -m "feat(copilot): wire CoPilotPanel into chat detail (use+manual logging)"
```

---

## Task 9: Add Mode toggle to `/ai-settings`

**Files:**
- Modify: `frontend/src/pages/ai-settings.js`
- Possibly: `backend/routes/settings.js` (if PUT for ai_mode missing)

- [ ] **Step 1: Verify backend supports updating `ai_mode`**

```bash
grep -n "ai_mode\|router.put\|router.post.*setting" /home/krttpt/crm/backend/routes/settings.js
```

If there's no admin PUT/POST for arbitrary settings, add one (admin-only):

```js
router.put('/:key', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  const allowed = new Set(['ai_mode', 'first_response_sla_seconds', 'followup_sop_minutes', 'suggestion_deviation_threshold']);
  if (!allowed.has(req.params.key)) return res.status(400).json({ error: 'key_not_settable' });
  const v = JSON.stringify(req.body?.value);
  await pg.query(
    `INSERT INTO crm_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [req.params.key, v]
  );
  res.json({ ok: true });
});
```

- [ ] **Step 2: Add Mode card at top of `/ai-settings` page**

```jsx
function ModeToggleCard() {
  const toast = useToast();
  const settings = useSWR('/api/settings', fetcher);
  const current = settings.data?.ai_mode || 'auto';
  const [mode, setMode] = useState(current);
  useEffect(() => { setMode(current); }, [current]);

  async function apply() {
    if (mode === current) return;
    if (mode === 'copilot' && !confirm(
      'Pindah ke Co-Pilot: AI berhenti auto-reply semua conversation aktif.\n' +
      'Operator wajib handle setiap pesan masuk.\n\nLanjutkan?'
    )) return;
    try {
      await api('/api/settings/ai_mode', { method: 'PUT', body: { value: mode } });
      toast.success(`Mode aktif: ${mode}`);
      settings.mutate();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2">
      <h2 className="text-sm font-semibold text-slate-800">Mode AI</h2>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="ai_mode" value="auto" checked={mode === 'auto'}
          onChange={(e) => setMode(e.target.value)} className="mt-1" />
        <div><div className="font-medium">Auto</div>
          <div className="text-xs text-slate-500">AI auto-reply ke customer (default).</div></div>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="ai_mode" value="copilot" checked={mode === 'copilot'}
          onChange={(e) => setMode(e.target.value)} className="mt-1" />
        <div><div className="font-medium">Co-Pilot</div>
          <div className="text-xs text-slate-500">AI generate suggestion, operator yang reply.</div></div>
      </label>
      <button onClick={apply} disabled={mode === current}
        className="text-sm px-3 py-1.5 rounded-md bg-brand-500 text-white hover:bg-brand-600 disabled:bg-slate-300">
        Apply
      </button>
      {mode === 'copilot' && current !== 'copilot' && (
        <div className="text-xs text-amber-700 mt-1">
          ⚠ Setelah Apply: customer langsung idle kalau operator nggak available.
        </div>
      )}
    </div>
  );
}
```

Render at top of the page.

- [ ] **Step 3: Build + smoke test**

```bash
cd /home/krttpt/crm/frontend && npm run build 2>&1 | tail -10
pm2 restart crm-backend crm-frontend && sleep 3
```

Open `/ai-settings`, see Mode card. Switch to Copilot, click Apply → confirm dialog → success toast. Verify DB:
```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c "SELECT value FROM crm_settings WHERE key='ai_mode';"
```
Expected: `"copilot"`.

Switch back to Auto via UI. Verify DB returns to `"auto"`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/ai-settings.js backend/routes/settings.js
git commit -m "feat(copilot): /ai-settings — Mode toggle card (Auto / Co-Pilot)"
```

---

## Task 10: End-to-end smoke

- [ ] **Step 1: Toggle copilot mode**

Via `/ai-settings` UI → set Co-Pilot.

- [ ] **Step 2: Send test inbound to dev WAHA from a sandbox WhatsApp**

Send: `"berapa harga bouquet sunflower untuk kirim ke Bandung besok?"`

- [ ] **Step 3: Verify backend log + DB**

```bash
pm2 logs crm-backend --lines 30 --nostream | grep -E "copilot|suggestion"
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, generation_ms, jsonb_array_length(options) AS n_opts FROM crm_suggestion_log ORDER BY id DESC LIMIT 1;"
```

Expected: `n_opts = 4`, `generation_ms < 5000`.

Verify NO ai-sent outbound:
```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, sender_type, body FROM crm_messages WHERE created_at > now() - interval '2 minutes' AND direction='out' ORDER BY id DESC;"
```

Expected: empty (or only system messages).

- [ ] **Step 4: Verify UI renders panel**

Open `/inbox/<conv-id>` → 4 cards visible, generation_ms shown in header.

- [ ] **Step 5: Click Use #2, verify composer fills**

Click button [Use 2]. Textarea fills with case option text.

- [ ] **Step 6: Edit slightly, click Kirim**

Modify a few words, click Kirim. Verify:
- Outbound message appears in WA + chat thread
- DB log updated:

```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, picked_rank, usage_type, edit_distance, pick_latency_ms, staff_id FROM crm_suggestion_log ORDER BY id DESC LIMIT 1;"
```

Expected: `picked_rank = 2`, `usage_type = 'edited'`, `edit_distance > 0 < 0.5`, `staff_id` populated.

- [ ] **Step 7: Test regenerate**

Click [🔄 Regenerate]. Panel refreshes with new options. Verify `regen_count` incremented:
```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, regen_count FROM crm_suggestion_log ORDER BY id DESC LIMIT 1;"
```

- [ ] **Step 8: Test flag**

Click 🚩 Flag → Off-tone. Verify:
```bash
psql "postgresql://vonage_sync@localhost:5432/vonage_reports" -c \
  "SELECT id, flagged_reason FROM crm_suggestion_log ORDER BY id DESC LIMIT 1;"
```
Expected: `flagged_reason = 'off_tone'`.

- [ ] **Step 9: Switch back to Auto + verify auto-reply works again**

Toggle to Auto. Send another test inbound. Verify outbound `sender_type='ai'` appears within 30s.

- [ ] **Step 10: Final commit (test fixes if any)**

```bash
git status
git add -A
git commit -m "test(copilot): e2e smoke — mode toggle + suggestion lifecycle verified"
```

---

## Acceptance Criteria Mapping (Phase 1 only)

| AC | Verified by Task |
|---|---|
| AC-A1 admin toggle persisted | Task 9 step 3 |
| AC-A2 copilot no outbound | Task 5 step 4, Task 10 step 3 |
| AC-A3 suggestion ≤3s p50 | Task 4 step 3, Task 10 step 3 |
| AC-A4 mode switch doesn't break flow | Task 10 step 9 |
| AC-B1 4 opts (3 case + 1 AI) | Task 4 step 3 |
| AC-B2 fallback low_confidence | Task 3 step 2 (NONSENSE case) |
| AC-B3 log populated each inbound | Task 5 step 5 |
| AC-B4 pick → log updated | Task 10 step 6 |
| AC-C1 panel renders when copilot | Task 10 step 4 |
| AC-C2 Use auto-fills | Task 10 step 5 |
| AC-C3 edit tracked | Task 10 step 6 |
| AC-C4 multi-operator sync | Task 7 (socket handlers) — manual verify with 2 browsers |
| AC-C5 mobile collapsed | Task 7 (collapse state) — manual verify on mobile viewport |
| AC-C6 keyboard shortcuts | Task 7 (key handler) — manual verify |

---

## Phase 2 / Phase 3 — separate plans

After Phase 1 lands and runs in production for 1+ week (collect baseline data on suggestion log), write:
- `2026-05-XX-ai-copilot-phase2-lead-temperature.md` — leadTemperature service, integration into webhook + pipeline events, UI badges, backfill script
- `2026-05-XX-ai-copilot-phase3-supervisor-scoring.md` — red flag detector, scoreAggregator, supervisor dashboard, Telegram critical alerts

Both depend on Phase 1's `crm_suggestion_log` data.
