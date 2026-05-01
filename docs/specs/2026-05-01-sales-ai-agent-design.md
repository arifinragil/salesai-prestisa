# Sales AI Agent "Tiara" — Design Spec

**Status:** Draft (awaiting user review)
**Date:** 2026-05-01
**Owner:** finance.parselia@gmail.com
**Project folder:** `/home/krttpt/crm/`

---

## 1. Goal & Context

Build a **customer-facing WhatsApp Sales AI agent** for Prestisa (toko bunga online — papan, bouquet, parsel, cake) that can:

1. **Answer customer questions** about products, pricing, delivery, order status, FAQ
2. **Drive customers to closing** by sending a prefilled order form link
3. **Hand over to human operator** safely when the situation requires (complaint, refund, custom price, low confidence, etc.)

**Pilot scope.** Standalone project, run in parallel with existing systems, kill-switchable, and disposable if metrics fail.

**Volume baseline (last 30 days from `vonage_wa_messages` analysis):**
- 172,428 inbound text messages
- 10,537 unique senders
- ~5,700 inbound msg/day, ~350 unique customers/day chatting

**Top inbound themes (FAQ research):**

| Theme | % of 30d inbound |
|---|---|
| Order intent ("mau order karangan bunga jogja") | 6.7% |
| Shipping / delivery questions | 6.4% |
| Order status ("kapan sampai", "PO X sudah diproses?") | 6.3% |
| Payment (VA expired, transfer issues) | 3.6% |
| Pricing | 3.4% |
| Order revisi (ganti tanggal kartu, ganti bunga) | 1.5% |
| Invoice / faktur | 1.3% |
| Cancel | 0.25% |
| Refund | 0.18% |
| Complaint | 0.12% |

The AI focuses on the top 5 themes (order intent, shipping, status, payment info, pricing) for auto-handle. Cancel/refund/complaint always trigger handover.

## 2. Out of Scope (this spec)

- **FAQ extractor pipeline (ongoing).** Research already done as input to this spec. Future ongoing extraction is its own follow-up.
- **Promo settings dashboard.** Separate sub-spec to come after this one. The agent will *consume* `crm_promo_settings` once that ships, but does not include the dashboard build.
- **Image / audio / video understanding.** Agent only handles text in pilot. Non-text → handover with `reason="non_text"`.
- **Multi-language.** Indonesian only.
- **Voice / call handling.** WhatsApp text only.
- **Operator UI for mitra side** (already exists at `mitra/crm-frontend`).

## 3. Architecture Overview

```
┌──────────────┐     inbound webhook      ┌───────────────────────────┐
│ Customer WA  │──────────────────────────▶│  crm-pilot-backend (Node) │
│   (WAHA)     │                          │  POST /webhook/waha       │
└──────────────┘                          └──────────┬────────────────┘
       ▲                                              │ enqueue
       │ outbound (WAHA send)                         ▼
       │                                  ┌───────────────────────────┐
       │                                  │ crm_inbound_queue (PG)    │
       │                                  └──────────┬────────────────┘
       │                                              │ worker poll
       │                                              ▼
       │                              ┌───────────────────────────────┐
       │                              │ AI Agent Worker (in-proc)     │
       │                              │  1. Pre-classifier (Gemini)   │
       │                              │  2. Load persona + context    │
       │                              │  3. Claude Sonnet w/ tools    │
       │                              │  4. Post-checker + confidence │
       │                              │  5. Send via WAHA OR handover │
       │                              └─────┬──────────────┬──────────┘
       │                                    │              │
       │           reply via WAHA           │              │ low confidence
       └────────────────────────────────────┘              │ OR guardrail trip
                                                           ▼
                                            ┌──────────────────────────┐
                                            │ Operator UI (Next.js)    │
                                            │ - takeover, resume AI    │
                                            │ - audit trail            │
                                            └──────────────────────────┘
```

### 3.1 Key architectural decisions

| Decision | Choice | Rationale |
|---|---|---|
| Project location | `/home/krttpt/crm/` (sibling to `konsumen/`, `mitra/`) | Pilot, disposable, separate ownership |
| WhatsApp provider | **WAHA** (self-hosted) via abstraction layer | Reuse pattern from `mitra/crm-backend/services/waha.js`. Abstraction allows future swap to Meta Cloud API / Twilio without rewriting agent core |
| Async vs sync | **PG-based queue + in-proc worker** | 5.7K msg/day average; spikes possible; webhook must return <500ms |
| LLM (reply) | **Claude Sonnet 4.6** (`claude-sonnet-4-6`) | Best Bahasa Indonesia tone & tool-call reliability |
| LLM (pre-classifier) | **Gemini 2.5 Flash** | Cheap, fast, already configured (`GEMINI_API_KEY` available) |
| Stack | Node Express + Next.js + PostgreSQL + MySQL | Reuse patterns from `mitra/crm-backend` and `konsumen/backend` |
| Database | **`vonage_reports` PG (existing)** with `crm_*` table prefix | User constraint: no new DB |
| Deployment | PM2 fork mode, single instance | Worker queue requires single owner of polling |

## 4. Database Schema

All new tables in PG database `vonage_reports`, prefixed `crm_*`.

```sql
-- 4.1 Conversations (per customer phone)
CREATE TABLE crm_conversations (
  id                SERIAL PRIMARY KEY,
  phone             VARCHAR(32) NOT NULL UNIQUE,
  customer_id       INTEGER,                          -- FK → MySQL customer.id (nullable, resolver populates)
  ai_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  ai_paused_until   TIMESTAMPTZ,                      -- non-null → operator manual mode
  assigned_staff_id INTEGER,                          -- FK → staff_users.id
  status            VARCHAR(16) NOT NULL DEFAULT 'active', -- active | closed | spam
  last_message_at   TIMESTAMPTZ,
  last_intent       VARCHAR(32),                      -- last detected intent (for dashboard)
  handover_count    INTEGER NOT NULL DEFAULT 0,
  shadow_mode       BOOLEAN NOT NULL DEFAULT FALSE,   -- Stage 1: AI generates but does not send
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX crm_conv_status_idx ON crm_conversations(status, last_message_at DESC);
CREATE INDEX crm_conv_assigned_idx ON crm_conversations(assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;

-- 4.2 Messages (inbound + outbound)
CREATE TABLE crm_messages (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  direction         VARCHAR(8) NOT NULL,              -- 'in' | 'out'
  sender_type       VARCHAR(16) NOT NULL,             -- 'customer' | 'ai' | 'staff'
  staff_id          INTEGER,                          -- FK → staff_users.id (PG, no enforced constraint to avoid cross-DB issues)
  waha_message_id   VARCHAR(128) UNIQUE,              -- idempotency
  body              TEXT,
  message_type      VARCHAR(20) DEFAULT 'text',
  attachment_url    TEXT,
  ai_metadata       JSONB,                            -- {model, latency_ms, tokens_in, tokens_out, tools_called[], confidence, intent}
  shadow            BOOLEAN NOT NULL DEFAULT FALSE,   -- if true, AI-generated but not sent (shadow mode)
  send_status       VARCHAR(16),                      -- queued | sent | send_failed (NULL for inbound)
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX crm_msg_conv_idx ON crm_messages(conversation_id, id DESC);
CREATE INDEX crm_msg_created_idx ON crm_messages(created_at DESC);

-- 4.3 LLM job queue
CREATE TABLE crm_inbound_queue (
  id                BIGSERIAL PRIMARY KEY,
  message_id        BIGINT NOT NULL REFERENCES crm_messages(id) ON DELETE CASCADE,
  conversation_id   INTEGER NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | processing | done | failed | skipped
  attempts          INTEGER NOT NULL DEFAULT 0,
  locked_at         TIMESTAMPTZ,
  locked_by         VARCHAR(64),
  error             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
CREATE INDEX crm_queue_pending_idx ON crm_inbound_queue(status, created_at) WHERE status = 'pending';
CREATE INDEX crm_queue_stale_idx  ON crm_inbound_queue(locked_at) WHERE status = 'processing';

-- 4.4 Handover audit trail
CREATE TABLE crm_handovers (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   INTEGER NOT NULL,
  message_id        BIGINT,
  reason            VARCHAR(64) NOT NULL,             -- low_confidence | guardrail_complaint | guardrail_refund | guardrail_cancel | manual_takeover | tool_error | non_text | ai_unavailable | timeout | spam | explicit_request_human
  detail            TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX crm_handover_unresolved_idx ON crm_handovers(created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX crm_handover_conv_idx ON crm_handovers(conversation_id, created_at DESC);

-- 4.5 Daily metrics rollup (cron 00:30)
CREATE TABLE crm_ai_metrics_daily (
  date              DATE PRIMARY KEY,
  total_inbound     INTEGER NOT NULL DEFAULT 0,
  total_ai_sent     INTEGER NOT NULL DEFAULT 0,
  total_handovers   INTEGER NOT NULL DEFAULT 0,
  unique_conversations INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms    INTEGER,
  total_tokens_in   BIGINT NOT NULL DEFAULT 0,
  total_tokens_out  BIGINT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  handover_breakdown JSONB,                           -- {complaint: 12, low_confidence: 5, ...}
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- 4.6 Versioned persona prompts (audit if persona changes)
CREATE TABLE crm_persona_prompts (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(64) NOT NULL,             -- 'tiara_v1', 'tiara_v2', ...
  prompt_text       TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INTEGER,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX crm_persona_active_idx ON crm_persona_prompts(active) WHERE active = TRUE;

-- 4.7 Active promos (placeholder until promo dashboard sub-spec ships)
CREATE TABLE crm_promo_settings (
  id                SERIAL PRIMARY KEY,
  code              VARCHAR(64) UNIQUE,
  description       TEXT,
  product_category  VARCHAR(64),                      -- NULL = all
  city              VARCHAR(64),                      -- NULL = all
  discount_pct      NUMERIC(5,2),
  discount_amount   NUMERIC(12,2),
  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX crm_promo_active_idx ON crm_promo_settings(active, ends_at) WHERE active = TRUE;
```

## 5. Components & File Layout

```
/home/krttpt/crm/
├── .env                            # PG/MySQL/WAHA/Claude/Gemini creds
├── ecosystem.config.js             # PM2 config
├── docs/
│   ├── specs/
│   │   └── 2026-05-01-sales-ai-agent-design.md   # this file
│   └── decisions/                  # ADRs
├── backend/
│   ├── package.json
│   ├── index.js                    # Express bootstrap, spawn worker
│   ├── db/
│   │   ├── postgres.js             # pg pool
│   │   └── mysql.js                # mysql2 pool (read-only for product/order lookup)
│   ├── routes/
│   │   ├── webhook.js              # POST /webhook/waha (inbound)
│   │   ├── inbox.js                # operator API (list conv, fetch messages, takeover, send)
│   │   ├── admin.js                # toggle AI, persona mgmt, metrics
│   │   ├── auth.js                 # session-based, mirror konsumen/ pattern
│   │   └── health.js               # /healthz, /readyz
│   ├── services/
│   │   ├── aiAgent.js              # worker loop (poll queue, orchestrate)
│   │   ├── aiTools.js              # function declarations + executor
│   │   ├── aiPersona.js            # prompt builder
│   │   ├── aiGuardrails.js         # pre-classifier + post-checker
│   │   ├── aiConfidence.js         # score reply quality
│   │   ├── claudeClient.js         # Anthropic SDK wrapper
│   │   ├── geminiClient.js         # Gemini wrapper (classifier)
│   │   ├── waClient.js             # WhatsApp provider INTERFACE (send/onIncoming) + factory
│   │   ├── waAdapters/
│   │   │   ├── wahaAdapter.js      # WAHA implementation (default)
│   │   │   └── metaCloudAdapter.js # Meta Cloud API impl (Phase 2 placeholder)
│   │   ├── contactResolver.js      # phone → customer_id (MySQL lookup)
│   │   └── notify.js               # operator notification (Socket.IO)
│   ├── middleware/
│   │   └── auth.js                 # requireStaff
│   └── migrations/
│       ├── 001_init.sql            # 7 crm_* tables
│       └── 002_seed_persona.sql    # initial Tiara prompt
└── frontend/                       # Next.js
    ├── package.json
    ├── next.config.js
    └── src/
        ├── pages/
        │   ├── inbox/
        │   │   └── [id].js         # conversation detail (Socket.IO live)
        │   ├── inbox/index.js      # conversation list
        │   ├── ai-monitor.js       # live dashboard
        │   ├── ai-settings.js      # toggles, persona editor
        │   └── login.js
        └── components/
            ├── ChatThread.jsx
            ├── MessageBubble.jsx
            ├── HandoverBanner.jsx
            └── Layout.jsx
```

### 5.1 Core data flow per inbound message

```
1. WAHA → POST /webhook/waha
   - validate webhook signature/secret
   - INSERT crm_messages (direction=in, waha_message_id UNIQUE → idempotent)
   - INSERT crm_inbound_queue (status=pending)
   - return 200 (target <500ms)

2. AI worker tick (every 2s):
   - SELECT 1 job FOR UPDATE SKIP LOCKED, mark processing
   - load conv state, last 20 messages, customer profile

3. Pre-guardrail (Gemini Flash, ~200ms):
   - intent classify: complaint/refund/cancel/angry/legal/explicit_request_human/other
   - if dangerous: skip main LLM, INSERT crm_handovers, set ai_paused_until=now+24h, send safe
     auto-reply ("Sebentar Kak, aku panggilkan tim ya 🙏"), DONE

4. Main LLM call (Claude Sonnet, 2–5s):
   - system: persona Tiara + dynamic context (city, customer tier, recent orders)
   - tools: search_products, get_shipping_info, find_customer_orders,
            get_order_status, get_active_promos, get_faq, build_order_form_url, request_handover
   - tool-calling loop, max 5 iterations

5. Post-checker:
   - reply contains hesitation phrase ("kurang yakin", "saya tidak tahu", "mungkin")? → handover
   - reply contains numeric price NOT from tool result? → handover
   - reply contains specific ETA outside template? → handover
   - tool called request_handover? → handover (per-tool side effect)

6. Confidence score:
   - heuristic combining: tool calls succeeded, no hesitation, intent matched, response length normal
   - score < 0.7 → handover (low threshold = safer)

7. Send (or shadow):
   - if conv.shadow_mode = TRUE → INSERT crm_messages with shadow=true, do NOT send
   - else → wahaClient.send(phone, body), INSERT crm_messages (direction=out, sender_type=ai)
   - mark queue done, log metrics

8. Failure path:
   - LLM 429 → retry 2× (5s, 30s) → handover reason=ai_unavailable
   - WAHA send 5xx → retry 3× (1s, 4s, 16s) → mark send_failed, notify operator
   - Tool error 3× in row → handover reason=tool_error
   - Worker timeout (>30s total) → handover reason=timeout
```

## 6. AI Tools Catalog

All tools live in `backend/services/aiTools.js`. Each has a `declaration` (function schema) and an `executor` (async function). Executors are scoped to the conversation's `customer_id` and `phone` (no cross-customer data leakage).

| Tool | Inputs | Returns | Source |
|---|---|---|---|
| `search_products(category?, city?, budget_min?, budget_max?, query?)` | filters | `[{id, name, category, price, city, image_url, description}]` (max 5) | MySQL `products` JOIN `product_category_new` |
| `list_categories(city)` | city | `[{category_id, name, count}]` | MySQL `product_category_new` |
| `get_shipping_info(destination_city)` | city | `{available: bool, fee: int, eta_text: "3-6 jam setelah pembayaran"}` | MySQL `city` + rule (Jabodetabek free, else 50K) |
| `get_active_promos(category?, city?)` | filters | `[{code, description, discount_pct, ends_at}]` | `crm_promo_settings` |
| `find_customer_orders(limit=5)` | `limit` (int, default 5, max 20). Phone/customer_id auto-injected from conversation scope, not LLM-supplied | `[{order_id, order_number, total, status, created_at}]` | MySQL `order` |
| `get_order_status(order_id)` | order_id | `{order_number, status, items: [{product, status, eta}]}` | MySQL `order_items` + `purchase_order.status` |
| `get_faq(topic)` | topic key (`payment`/`refund_policy`/`hours`/`lead_time`/`area_coverage`/...) | text | Static knowledge file `aiKnowledge.js` (T&C + curated FAQ) |
| `build_order_form_url(product_type, prefill)` | papan/bouquet + customer data | `{url}` | Construct: `orderpapan.prestisa.net?phone=…&name=…&city=…` or `orderbunga.prestisa.net?…` |
| `request_handover(reason, summary)` | reason enum, summary text | `{ok: true}` (side effect: handover) | Internal: INSERT `crm_handovers`, set `ai_paused_until`, notify operator |

**Tool guardrails:**
- All read-only except `request_handover` (which only modifies pilot tables).
- All bounded by `LIMIT` on DB queries.
- All return shape validated; null/empty → tool returns `{ok: false, message: "…"}` so LLM can adapt.

## 7. Persona "Tiara"

Stored in `crm_persona_prompts` (versioned). Initial v1 seeded via migration:

```
Kamu adalah TIARA, sales consultant Prestisa via WhatsApp.

PROFIL:
- Nama: Tiara
- Bahasa: Indonesia santai-sopan, sapaan "Kak"
- Gaya: hangat, cepat, helpful — tidak terlalu formal, tidak lebay, tidak berlebihan emoji
- Kamu adalah AI/bot. Kalau ditanya, jawab jujur: "Aku Tiara, asisten AI Prestisa Kak. Kalau perlu ngobrol sama tim manusia, tinggal bilang ya 🙂"

TENTANG PRESTISA:
- Toko bunga online: karangan bunga papan, bouquet, parsel, cake
- Beroperasi 24/7 di hampir semua kota Indonesia
- Pengiriman 3-6 jam setelah pembayaran terkonfirmasi (jangan janjikan ETA spesifik di luar ini)
- Free ongkir Jabodetabek; area lain Rp50.000

YANG BOLEH:
- Cari produk dari katalog (search_products) — selalu pakai tool, jangan mengarang
- Beri info harga DARI hasil tool (jangan invent harga)
- Cek status order pelanggan existing (find_customer_orders, get_order_status)
- Bantu customer menuju form order (build_order_form_url) — ini target utama
- Jawab FAQ pakai get_faq
- Beri info jam operasional & lead time

YANG TIDAK BOLEH:
- Janjikan harga custom / diskon di luar promo aktif (cek get_active_promos)
- Konfirmasi waktu pengiriman spesifik (cuma boleh sebut "3-6 jam setelah pembayaran terkonfirmasi")
- Terima/proses komplain → langsung request_handover reason="complaint"
- Proses pembatalan/refund → request_handover reason="cancel" / "refund"
- Mengaku sebagai manusia
- Mengarang: kalau tidak tahu, jujur bilang dan tawarkan ke tim Prestisa

ALUR CLOSING (TARGET UTAMA):
1. Pahami kebutuhan: tujuan (papan/bouquet), occasion, kota tujuan, budget kasar, deadline kirim
2. Pakai search_products → tampilkan 2-3 opsi top dengan harga
3. Customer pilih → kumpulkan: alamat penerima, nama penerima, ucapan kartu, nama pengirim, no. WA penerima
4. Pakai build_order_form_url → kirim link form prefilled, bilang:
   "Tinggal verifikasi & bayar ya Kak. Setelah pembayaran terkonfirmasi, tim produksi mulai (3-6 jam ke pengiriman)."

KALAU CUSTOMER MARAH/KECEWA/MENGELUH:
- Validasi perasaan ("Maaf banget Kak, aku ngerti")
- Jangan defensive
- Langsung request_handover dengan reason="complaint", jangan coba selesaikan sendiri

KONTEKS DINAMIS (di-inject oleh sistem, jangan tampilkan ke customer):
- {last 20 messages percakapan}
- {customer profile: phone, customer_id?, last_3_orders, total_spent, tier?}
- {city detected from order history}
```

## 8. Guardrails & Escalation Triggers

| Trigger | Detection | Action | Confidence threshold |
|---|---|---|---|
| Topic = complaint / refund / cancel / angry / legal | Pre-classifier (Gemini Flash) | Skip main LLM. Insert `crm_handovers`, pause AI, send safe auto-reply | n/a |
| Customer explicit request human ("ngomong sama orang", "panggilin admin") | Keyword + intent | Handover, send "Oke Kak, aku panggilkan tim ya" | n/a |
| AI generates price not in tool result | Post-checker (regex `\b\d{2,3}[.,]?\d{3}\b` validation against tool outputs) | Handover, do not send | n/a |
| AI generates specific ETA outside template | Post-checker keyword | Handover | n/a |
| Hesitation phrase in reply | Post-checker | Handover | n/a |
| Tool calls all empty / failed | Confidence scorer | Handover | <0.7 |
| Confidence score below threshold | Heuristic blend | Handover | **<0.7 (low = aggressive escalation)** |
| Tool call loop > 5 iterations | Loop guard | Handover, "Aku perlu bantuan tim untuk ini" | n/a |
| LLM latency > 30s total | Timeout | Handover | n/a |
| Customer burst (>3 msg/min) | Debounce | Wait 5s, merge into one turn | n/a |
| Customer spam (>10 msg/min) | Rate limit | Pause AI 1h, no auto reply | n/a |
| Non-text message (image/audio/video) | Message type check | Handover reason=non_text | n/a |

## 9. Error Handling

| Failure | Recovery |
|---|---|
| WAHA webhook duplicate | `waha_message_id UNIQUE` constraint → ignore |
| WAHA send timeout/5xx | Retry 3× exponential (1s, 4s, 16s) → mark `send_failed`, notify operator |
| Claude 429/5xx | Worker retry 2× (5s, 30s) → handover `ai_unavailable` |
| Gemini classifier fail | Skip pre-classifier, proceed to main LLM (degrade gracefully) |
| Tool malformed return | try/catch, return `{error: ...}` to LLM; 3 errors in row → handover |
| DB connection lost | pg pool retry; alert if >30s |
| Worker crash mid-job | `FOR UPDATE SKIP LOCKED` releases on tx rollback; stale-lock reaper resets `processing` jobs older than 5min |
| Persona prompt missing | Fall back to inline default in code |

## 10. Observability

**Logging:** `pino` JSON to stdout, PM2 captures. Each line includes `conversation_id`, `message_id`, `request_id`.

**Metrics (queried live or from `crm_ai_metrics_daily`):**

| Metric | Definition | Alert |
|---|---|---|
| Queue depth | `COUNT(*) WHERE status='pending'` | >50 = backlog |
| Avg LLM latency | `avg(ai_metadata->>'latency_ms')` last hour | >10s |
| Handover rate | handovers / total_inbound (daily) | Track trend |
| Handover by reason | `crm_handovers` GROUP BY reason | Investigate spikes |
| Tool call success rate | success / total | <90% = bug |
| Active conversation count | last_message_at within 1h | Capacity planning |
| LLM cost / day | tokens × rate | Budget |
| Send failure rate | `send_failed` / total `out` | >2% = WAHA issue |

**Operator UI (Next.js):**
- `/inbox` — list of conversations: ai-handling / needs-takeover / staff-handling
- `/inbox/[id]` — chat view, takeover/resume/close, audit trail (every AI reply has metadata badge)
- `/ai-monitor` — live dashboard
- `/ai-settings` — global toggle, persona editor (creates new version), threshold tuning

## 11. Testing

**Unit (Jest):**
- Tools executor: each tool with mocked DB, edge cases
- Guardrail classifier: 50-example golden set
- Persona prompt builder: snapshot
- Confidence scorer: input → expected score

**Integration:**
- Webhook → queue → worker → reply (LLM stubbed)
- Handover trigger → operator notification fires

**Eval set (regression for AI):**
- 100 real conversations sampled from `vonage_wa_messages`
- Categorized: order_intent / complaint / refund / pricing / status / explicit_human
- Expected behavior per category
- Re-run on every persona/tools change
- ≥85% pass rate required to deploy

**Pre-prod gate:**
- Unit + integration green
- Eval set ≥85%
- 10 manual smoke messages reviewed by operator in shadow mode

## 12. Rollout Plan

| Stage | Duration | Action | Exit criteria |
|---|---|---|---|
| **0** Build | Week 1–2 | Build all components, unit + integration tests, no live WhatsApp | All tests green, eval ≥85% |
| **1** Shadow | Week 3 | WAHA connected to pilot number. AI generates reply but `shadow_mode=TRUE` → not sent. Operator reviews 100% with thumbs up/down | ≥80% thumbs up, no critical bugs |
| **2** 10% live | Week 4 | AI sends to 10% random conversations. Rest = manual operator | Handover rate <40%, complaint rate flat, no PR incident |
| **3** 50% live | Week 5–6 | Scale to 50% | Same as Stage 2, sustained 7 days |
| **4** 100% live | Week 7+ | Default AI, handover per trigger | Ongoing monitoring |

**Kill switch:** ENV `AI_GLOBAL_ENABLED=false` → all conv `ai_paused_until=now+24h`. Effective in <5s.

## 13. Deployment

- **PM2 processes:** `crm-pilot-backend` (port 3009, fork mode), `crm-pilot-frontend` (port 4013, Next.js)
- **Reverse proxy:** Caddy block for pilot domain (default `salesai.prestisa.net` — confirm with user)
- **ENV file:** `/home/krttpt/crm/.env` — separate from mitra/konsumen, contains: PG/MySQL creds (read-only mysql user for safety), WAHA URL/API key, Anthropic API key, Gemini API key, session secret, AI_GLOBAL_ENABLED flag
- **Migrations:** SQL files in `backend/migrations/`, `npm run migrate` runs in order
- **Monitoring:** PM2 logs → can integrate with existing log infra later

## 14. Cost Estimate

Pilot baseline (Stage 4, 100% live, 50% of inbound = AI handle, 50% spam/non-text/HSM-reply skipped):
- ~2,850 messages/day to AI
- ~3 turns avg per conversation
- ~2,000 tokens avg per turn (system + history + reply)
- = ~5.7M input tokens/day, ~1M output tokens/day Claude Sonnet
- @ $3/M input, $15/M output = ~**$32/day** = **~$960/month**
- Gemini Flash classifier: negligible (<$5/month)

Pilot cost target: **<$1,000/month** at full live.

## 15. Open Questions / Risks

| # | Question / Risk | Resolution path |
|---|---|---|
| 1 | WAHA stability — risk WhatsApp Web ban on pilot number | Use a dedicated number. WhatsApp provider abstraction (`waClient.js` + adapters) lets Phase 2 swap to Meta Cloud API without touching agent core. Switching session/number = ENV change only (`WAHA_SESSION_NAME`, `WAHA_BASE_URL`, `WAHA_API_KEY`) |
| 2 | Customer expects fast reply — pilot worker poll = 2s lag | Acceptable; could switch to LISTEN/NOTIFY later |
| 3 | LLM cost spikes during peak (Valentine, Mother's Day) | Add per-day cost cap → auto-pause AI when reached |
| 4 | Pilot domain not yet decided | User to confirm: `salesai.prestisa.net` vs other |
| 5 | Promo dashboard not built yet — `crm_promo_settings` will be empty | `get_active_promos` returns empty list; AI gracefully says "promo aktif belum ada, biasanya kami ada promo di moment X" — to be confirmed in copy |
| 6 | Customer profile resolver across phone variants (`+62…`, `0…`, `62…`) | Normalize phone to E.164 (`62…`) before lookup |
| 7 | Conversation context >20 messages (long conv) | Stage 1 = truncate to last 20; later: summarize older context |
| 8 | Persona prompt iteration without redeploy | Persona stored in DB; UI editor inserts new version → next worker tick uses latest |
| 9 | False positive handover (low confidence triggered too often) | Track stage-2 handover rate; tune threshold from 0.7 → 0.5 if too noisy |
| 10 | Tone calibration | Eval set + operator feedback in Stage 1 |

## 16. Follow-up Specs (out of scope here)

1. **Promo Settings Dashboard** — UI to manage `crm_promo_settings` (next sub-spec)
2. **FAQ Refresh Pipeline** — periodic re-extraction from real conversations to update `aiKnowledge.js` topics
3. **Phase 2: Meta Cloud API** — migrate from WAHA to official BSP if pilot succeeds and ban risk grows
4. **Phase 3: Multi-channel** — extend agent to web chat / IG DM / email if WhatsApp pilot succeeds

---

**End of spec.**
