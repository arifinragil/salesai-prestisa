# AI Co-Pilot Mode + Supervisor Control Panel — Design Spec

**Status:** Approved (brainstorm complete 2026-05-02)
**Owner:** finance.parselia@gmail.com
**Source PRD:** Google Doc `180Ks82T2k3gtT4fO2Egx5FQ_vAnFYLcNHZW8IFp5hkk` — "AI CRM Chat Copilot & Supervisor Control"
**Sub-project:** #4 (pivot dari Sub-project 3 retention)
**Migration:** `015_copilot.sql`

---

## 0. Konteks & Tujuan

Saat ini Tiara CRM operasi di mode **Auto** — AI agent reply customer langsung tanpa human in the loop, dengan handover ke operator hanya pada low-confidence/complaint/refund. PRD baru meminta tambahan **Co-Pilot Mode** — AI generate 4 suggestion, operator yang reply, plus dashboard **supervisor** untuk monitor performance agent (red flag, scoring, lead temperature).

### Tujuan
1. Beri admin toggle global Auto ↔ Co-Pilot.
2. Co-Pilot generate 4 suggestion per inbound (3 dari case library, 1 AI synthesis) dalam ≤3 detik.
3. Track operator behavior: pick rate, edit distance, manual override, response time.
4. Detect red flag deterministik (slow response, missed followup, hot lead ignored, dll) dan compute composite performance score per agent per hari.
5. Klasifikasi hot/warm/cold lead per conversation untuk prioritisasi.

### Non-tujuan
- Tidak mengganti existing Auto mode — coexist, toggle sebagai mode active.
- Tidak ML-based lead scoring — rule-based dulu, evaluate ML setelah 3 bulan data.
- Tidak per-conv mode override — global only (decided in Q1.c).

---

## 1. Arsitektur & Data Model

### 1.1 Setting global

Disimpan di `crm_settings` (existing key/value table):
```
ai_mode = "auto" | "copilot"               (default "auto")
first_response_sla_seconds = 60
followup_sop_minutes = 30
suggestion_deviation_threshold = 0.3       (0..1; edit distance ratio)
```

### 1.2 Migration `015_copilot.sql`

```sql
-- Mode toggle
INSERT INTO crm_settings (key, value)
VALUES ('ai_mode', '"auto"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Reply templates: extend dengan case matching fields
ALTER TABLE crm_reply_templates
  ADD COLUMN IF NOT EXISTS case_label varchar(80),
  ADD COLUMN IF NOT EXISTS case_pattern text,        -- regex untuk match inbound body
  ADD COLUMN IF NOT EXISTS intent_match varchar(32);  -- match Gemini intent label

-- Suggestion log
CREATE TABLE IF NOT EXISTS crm_suggestion_log (
  id              bigserial PRIMARY KEY,
  conversation_id int NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  inbound_msg_id  bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  shown_at        timestamptz DEFAULT now(),
  options         jsonb NOT NULL,             -- [{rank, source, text, confidence, template_id?}]
  generation_ms   int,
  picked_rank     smallint,                   -- 1..4 atau NULL kalau manual
  usage_type      varchar(10),                -- 'raw' | 'edited' | 'manual' | NULL (not yet used)
  sent_msg_id     bigint REFERENCES crm_messages(id) ON DELETE SET NULL,
  staff_id        int,
  pick_latency_ms int,
  edit_distance   numeric(4,3),               -- 0..1, levenshtein normalized
  flagged_reason  varchar(20),                -- off_tone|wrong|irrelevant|harmful
  flagged_note    text,
  regen_count     smallint DEFAULT 0
);
CREATE INDEX ON crm_suggestion_log (conversation_id, shown_at DESC);
CREATE INDEX ON crm_suggestion_log (staff_id, shown_at DESC) WHERE staff_id IS NOT NULL;

-- Agent red flag log
CREATE TABLE IF NOT EXISTS crm_agent_red_flags (
  id              bigserial PRIMARY KEY,
  staff_id        int NOT NULL,
  conversation_id int,
  rule_id         varchar(40) NOT NULL,
  severity        varchar(10) NOT NULL,       -- low|medium|high|critical
  detail          jsonb,
  detected_at     timestamptz DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     int,
  resolution_note text
);
CREATE INDEX ON crm_agent_red_flags (staff_id, detected_at DESC);
CREATE INDEX ON crm_agent_red_flags (severity, resolved_at) WHERE resolved_at IS NULL;

-- Daily aggregated performance score
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

-- Conversation: response timing + lead temp
ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS first_inbound_at  timestamptz,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS lead_temperature  varchar(8) DEFAULT 'cold',  -- hot|warm|cold
  ADD COLUMN IF NOT EXISTS lead_score        smallint;
CREATE INDEX ON crm_conversations (lead_temperature, last_message_at DESC);

-- New lost reasons (extend pipeline enum/check or seed lookup table — pilih per implementation existing)
-- Adds: belum_butuh, menunggu_approval, ongkir, stok_habis (decided in Q2.a)

-- SOP / threshold settings
INSERT INTO crm_settings (key, value) VALUES
  ('first_response_sla_seconds', '60'::jsonb),
  ('followup_sop_minutes', '30'::jsonb),
  ('suggestion_deviation_threshold', '0.3'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

---

## 2. Mode Toggle (Auto vs Co-Pilot)

### 2.1 Behavior matrix

| Event | `ai_mode = auto` (existing) | `ai_mode = copilot` (baru) |
|---|---|---|
| Customer pesan masuk | aiAgent generate reply, kirim langsung | aiAgent generate **4 suggestion**, store, push socket — TIDAK kirim ke WA |
| sendSeen (✓✓) | Webhook ingest (sudah live) | Sama — tetap fire |
| Operator buka chat | Lihat AI reply terkirim | Lihat 4 suggestion panel di atas composer |
| Handover refund/cancel | Existing flow | Existing flow tetap (handover bypass mode) |
| Spam filter | Existing | Existing |
| Cron outbound (recurring/delivery) | Tetap kirim | Tetap kirim (system message, bukan AI reply) |
| Quiet hours / typing delay | Active | Disabled (no outbound dari AI) |

### 2.2 Implementasi

- `aiAgent.processOne()` branch by `getSetting('ai_mode')`. Kalau `copilot` → call `generateSuggestions()` ganti `generateReply()`.
- `/ai-settings` UI: card paling atas dengan radio Auto / Co-Pilot + Apply button + confirmation modal saat switch.
- Switch dari `auto` → `copilot`: warning "Customer langsung idle kalau operator unavailable". Existing AI auto-reply di history tetap, no backfill.

---

## 3. Suggestion Engine

### 3.1 Pipeline (target ≤3 detik p50)

```
Customer pesan masuk → webhook ingest
  ↓ (existing: PII scrub, sentiment, intent classify ~500ms via Gemini)
Branch: ai_mode = copilot
  ↓ Parallel:
  ┌─ Step 1: Case library lookup → 3 opsi (~50ms, Postgres)
  └─ Step 2: AI elaboration → 1 opsi (~1.5s, Claude haiku)
  ↓
Aggregate → INSERT crm_suggestion_log → emit socket `suggestion:new`
```

### 3.2 Case library matching SQL

```sql
SELECT id, body, case_label, intent_match,
  (
    CASE WHEN intent_match = $intent THEN 50 ELSE 0 END +
    CASE WHEN $body_lower ~* case_pattern THEN 30 ELSE 0 END +
    GREATEST(0, 20 - EXTRACT(EPOCH FROM (now() - updated_at)) / 86400 / 30)
  ) AS relevance
FROM crm_reply_templates
WHERE active = TRUE
ORDER BY relevance DESC
LIMIT 3;
```

Kalau hasil < 3 atau semua relevance < 30 → pad dengan **fallback templates** (greeting, ask-clarify, escalate-prompt) + flag low-confidence.

### 3.3 AI elaboration prompt

Claude `claude-haiku-4-5`:
```
Customer: "{{inbound_text}}"
Intent: {{classified_intent}} (confidence {{conf}})
Context: 5 last turns

3 case suggestions yang sudah ada:
1. {{case_1_text}}
2. {{case_2_text}}
3. {{case_3_text}}

Tugas: generate 1 reply ALTERNATIF — synthesize/improve dari 3 suggestion
di atas, tetap dalam guidance Tiara persona. Output: hanya text reply.

Constraint:
- Bahasa Indonesia santai-sopan, sapaan "Kak"
- Max 200 kata
- Kalau 3 suggestion sudah cover semua angle, tawarkan kombinasi atau tambah CTA
```

### 3.4 Latency budget

| Step | Time |
|---|---|
| Intent classify (Gemini) | 500ms |
| Case library SQL | 50ms |
| AI elaboration (Claude haiku) | 1500ms |
| DB write + socket emit | 100ms |
| **Total p50** | **~2.2s** |

NFR-A1 ≤3s ✓.

---

## 4. Co-Pilot UI Panel

### 4.1 Layout `/inbox/[id]`

Panel di atas composer, di bawah message thread. 4 suggestion cards (3 case + 1 AI marked ✨), tombol [🔄 Regenerate] + [🚩 Flag bad suggestion].

### 4.2 Interaction flow

1. Inbound → socket `suggestion:new` → panel auto-show (skeleton selama generate)
2. Klik [Use] → composer ter-isi, focus textarea, log `picked_rank`
3. Edit teks → label "✏ edited from #N", track edit distance
4. Kirim → existing send flow + UPDATE `crm_suggestion_log` (`usage_type`, `edit_distance`, `pick_latency_ms`, `sent_msg_id`)
5. Manual ketik → `usage_type='manual'`, `picked_rank=NULL`
6. Regenerate → rate limit 1×/inbound (alert jika >3×)
7. Flag → modal pilih reason → `flagged_reason` + `flagged_note`

### 4.3 Multi-operator sync

Suggestion attached ke `inbound_msg_id` (bukan operator). Semua operator yang lihat conv ini dapat opsi sama. Saat operator A kirim → socket `suggestion:used` → operator B liat panel grayed-out "✓ digunakan oleh @arif (#2 edited)". Composer di B disabled 30s.

### 4.4 Mobile

Default collapsed di mobile, chip "🤖 4 suggestion · tap untuk lihat", expand on tap. Pulse + haptic on new inbound.

### 4.5 Empty/error states

- Generating: 4 skeleton cards (timeout @ 5s)
- AI elaboration timeout → opsi 4 fallback message
- All low confidence → yellow banner
- AI service down → red banner "Co-Pilot offline — reply manual atau switch ke Auto"

### 4.6 Keyboard shortcuts

`1`-`4` Use opsi · `R` Regenerate · `E` Edit · `Cmd/Ctrl+Enter` Kirim

### 4.7 API surface

```
GET  /api/conversations/:id/suggestions/latest
POST /api/conversations/:id/suggestions/regenerate
POST /api/conversations/:id/suggestions/:logId/use   { picked_rank, sent_text }
POST /api/conversations/:id/suggestions/:logId/flag  { reason, note? }
```

---

## 5. Supervisor Scoring + Red Flag Rules

### 5.1 Red flag rules

| Rule ID | Trigger | Severity |
|---|---|---|
| `slow_first_response` | First operator reply > SLA (60s default) | high |
| `missed_followup` | qualified/proposal_sent tanpa outbound > 30 min | high |
| `suggestion_deviation` | edit_distance > 0.3 berulang ≥5×/hari | medium |
| `manual_override_high` | usage_type=manual rate > 50%/hari | medium |
| `flagged_suggestion` | Operator flag harmful/off_tone | low |
| `lost_no_reason` | Conv close lost tanpa lost_reason | medium |
| `csat_low` | CSAT 1-2 dalam 7d | high |
| `discount_unauthorized` | Sebut harga/diskon yg tidak ada di crm_promos | high |
| `pii_leak` | Outbound mengandung PII non-customer | critical |
| `policy_violation` | Match keyword blacklist | high |
| `cold_lead_ignored` | Hot lead tanpa response > 5 min | critical |
| `handover_overuse` | Operator handover > 30% conv | low |

### 5.2 Composite score (0-100)

```
score =
    25 * conversion_rate
  + 20 * (1 - clamp(avg_response_time_sec/300))
  + 15 * (csat_avg / 5)
  + 15 * (suggestion_used_raw + 0.7 * suggestion_used_edited) / max(suggestion_shown, 1)
  +  5 * volume_factor(conv_handled)        -- diminishing return after 50/day
  - 10 * red_flags_high
  - 25 * red_flags_critical
  - 10 * if(missed_followup_count > 2)
```

Clamped [0, 100], persisted nightly via `scoreAggregator.js`.

### 5.3 Tier mapping

| Score | Tier | Indicator |
|---|---|---|
| 85-100 | 🟢 Excellent | Top performer recognition |
| 70-84 | 🔵 Solid | Normal |
| 55-69 | 🟡 Needs attention | Supervisor review weekly |
| < 55 | 🔴 Coaching required | 1-on-1 + remediation |

### 5.4 Cron jobs

```
*/1 * * * * node backend/scripts/redFlagRealtime.js   # cold_lead_ignored, hot lead miss
*/5 * * * * node backend/scripts/missedFollowup.js    # SOP timer
0 1 * * *   node backend/scripts/scoreAggregator.js   # nightly composite
```

### 5.5 Real-time alerts

- Critical → Telegram push ke supervisor + dashboard banner
- High → batched hourly digest
- Medium/Low → muncul di /supervisor (no push)

### 5.6 Supervisor dashboard `/supervisor`

- Tabel agent: nama, score hari ini + 7d trend, tier badge, open red flags count
- Drilldown: red flag log (filter by rule), suggestion usage chart, CSAT timeline, conv list
- Resolve red flag UI: "Mark resolved" + note
- Coach mode tags: "1-on-1 scheduled" / "remediation in progress"

---

## 6. Lead Temperature Classifier

### 6.1 Definisi

| Temp | Score | Definisi | Reply target |
|---|---|---|---|
| 🔥 hot | 70-100 | Strong buy intent (budget/deadline/"OK") | ≤2 min, escalate >5 min |
| 🌤️ warm | 40-69 | Active interest, compare/tanya detail | ≤10 min |
| 🧊 cold | 0-39 | Browsing/FAQ, no commitment | ≤30 min |

### 6.2 Rule-based formula

```
score = base + intent_signals + behavioral_signals
score *= recency_factor
```

#### Intent signals (dari Gemini classifier)

| Signal | Δ |
|---|---|
| order_intent (high conf) | +35 |
| payment / confirm_order | +30 |
| pricing | +15 |
| shipping (specific) | +20 |
| order_status (existing) | +10 |
| product_info | +5 |
| complaint / cancel | -20 |

#### Keyword regex

```js
HOT_KEYWORDS = [
  /\b(transfer kemana|nomor rek|rekening|VA|bayar dimana|bayar sekarang)\b/i,
  /\b(budget|anggaran)\s*(rp|sekitar)?\s*\d/i,
  /\b(deadline|harus sampai|wajib hari ini|urgent|asap)\b/i,
  /\b(sip|ok|deal|setuju|mau|jadi(?:in)?|fix(?:in)?)\b/i,
  /\b(kapan bisa kirim|siap kirim|delivery besok)\b/i,
];
WARM_KEYWORDS = [
  /\b(harga|berapa|murah|diskon|promo)\b/i,
  /\b(tersedia|ready|stok|ada ngga|ada|tanggal)\b/i,
  /\b(model|warna|ukuran|pilihan)\b/i,
];
```

#### Behavioral

| Signal | Δ |
|---|---|
| Klik order URL | +15 |
| Form submitted | → score 100, hot |
| Multi-turn (≥3 customer msg / 30 min) | +10 |
| Past order (existing customer) | +10 |
| Pipeline qualified/proposal_sent | +20 |
| Pipeline lost recently (<30d) | -15 |

#### Recency decay

```
recency_factor = max(0, 1 - (minutes_since_last_inbound / 120))
score *= (0.4 + 0.6 * recency_factor)
```

### 6.3 Triggers

- Webhook ingest (after spam check, before AI queue)
- Pipeline event apply
- Cron `*/5 min` sweep idle convs (recency decay)

### 6.4 UI surfacing

| Surface | Display |
|---|---|
| Inbox list | Badge 🔥/🌤️/🧊 + sort "by temp desc" |
| Chat header | "🔥 Hot lead · score 82 · last inbound 1m ago" |
| Co-pilot panel | Hot → banner "🔥 Close ASAP" |
| Pipeline board | Card border by temp |
| Supervisor dash | Filter "hot leads not responded > 3 min" |

### 6.5 Notifications

- Hot lead + no response 3 min → Telegram alert ke conv owner
- Hot lead + no response 5 min → escalate ke supervisor (red flag `cold_lead_ignored` critical)

### 6.6 Backfill

`scripts/backfillLeadTemperature.js` run-once: convs with `last_message_at > now() - 30d`, compute initial score.

---

## 7. ADR / Decision Log

| # | Decision | Rationale | Alternatives considered |
|---|---|---|---|
| 1 | Toggle global mode (Q1.c) | Operator team kecil, simple ops | Per-conv (rejected: complexity) |
| 2 | Extend `crm_reply_templates` (Q3.a) | Reuse existing seed + UI | New `crm_case_library` table (rejected: duplication) |
| 3 | New column `lead_temperature` (Q4.b) | Per-conv granularity, rule-based fast | LLM classifier (rejected: latency + cost) |
| 4 | Add 4 new lost reasons (Q2.a) | PRD requirement, granular funnel | Replace existing 8 (rejected: backward compat) |
| 5 | 3 case + 1 AI synthesis | Balance speed + freshness | All AI (rejected: latency); All template (rejected: brittleness) |
| 6 | Suggestion attached to msg, not operator | Multi-operator visibility | Per-operator (rejected: duplicate AI cost) |
| 7 | Rule-based scoring | Deterministic, explainable | ML (deferred: needs 3mo data) |

---

## 8. Acceptance Criteria

### AC-A: Mode toggle
- AC-A1 Admin dapat switch mode di `/ai-settings`, persist di `crm_settings.ai_mode`
- AC-A2 Saat copilot, AI tidak kirim outbound ke customer (verify: log inbound test → no message in `crm_messages` direction=out sender=ai)
- AC-A3 Saat copilot, suggestion muncul di chat detail dalam ≤3s p50
- AC-A4 Switch mode tidak break existing handover/spam/cron flow

### AC-B: Suggestion engine
- AC-B1 4 opsi muncul: 3 case + 1 AI (tagged `source` di JSONB)
- AC-B2 Kalau case library kosong → 4 fallback dengan low_confidence_warning
- AC-B3 `crm_suggestion_log` terisi `shown_at` + `options` setiap inbound
- AC-B4 Pick → `usage_type='raw'/'edited'`, `pick_latency_ms`, `edit_distance` ter-update

### AC-C: Co-pilot UI
- AC-C1 Panel render di `/inbox/[id]` saat `ai_mode=copilot` + ada inbound msg
- AC-C2 Klik [Use] auto-fill composer + focus
- AC-C3 Edit ter-track via diff vs source option
- AC-C4 Multi-operator: socket `suggestion:used` mencegah double-reply
- AC-C5 Mobile collapsed default + tap to expand
- AC-C6 Keyboard shortcuts berfungsi

### AC-D: Supervisor scoring
- AC-D1 Red flag rules trigger sesuai severity matrix (test masing-masing)
- AC-D2 `crm_agent_daily_scores` populated nightly via cron
- AC-D3 `performance_score` formula clamped [0,100], tier mapping correct
- AC-D4 `/supervisor` dashboard render agent table + drilldown
- AC-D5 Critical red flag → Telegram push ke supervisor (mock test)

### AC-E: Lead temperature
- AC-E1 Setiap inbound → `lead_temperature` + `lead_score` ter-update
- AC-E2 Hot signal terdeteksi: keyword "transfer kemana" + intent payment → score ≥70
- AC-E3 Recency decay setelah 2h idle → drift back to cold
- AC-E4 Hot lead no-response 5 min → red flag `cold_lead_ignored` critical + alert
- AC-E5 Backfill script populate semua conv 30d terakhir

---

## 9. Non-Functional Requirements

| Code | Requirement |
|---|---|
| NFR-A1 | Suggestion generation p50 ≤ 3000ms, p95 ≤ 5000ms |
| NFR-A2 | Lead temperature compute < 50ms (no LLM) |
| NFR-A3 | Score aggregator nightly run < 5 min for 1000 agents |
| NFR-A4 | Suggestion log retention 90 days, auto-prune via cron |
| NFR-A5 | Red flag log retention 365 days |
| NFR-A6 | Co-pilot UI mobile responsive (375px min) |

---

## 10. Open Items / Phase 2

- ML-based lead scoring (after 3mo data)
- Custom red flag rule editor di `/supervisor/settings`
- Per-team mode (mode = auto for team A, copilot for team B)
- Suggestion A/B testing framework (variant prompt comparison)
- Voice note input ke composer (via Whisper API)
- Auto-coach: AI-generated 1-on-1 talking points dari red flag pattern

---

## 11. Implementation Plan Reference

Next step: invoke `superpowers:writing-plans` skill with this spec → step-by-step plan per file/task with checkpoint tests.

Estimated scope:
- ~1 migration (015_copilot.sql)
- ~6 backend services (suggestionEngine, leadTemperature, redFlagDetector, scoreAggregator, supervisorRoutes, settingsExtension)
- ~3 frontend pages/components (CoPilotPanel, SupervisorDashboard, AISettings update)
- ~4 cron scripts (redFlagRealtime, missedFollowup, scoreAggregator, backfillLeadTemperature)
- ~12 new API endpoints
