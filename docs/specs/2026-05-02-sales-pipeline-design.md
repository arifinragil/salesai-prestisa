# Sales Pipeline & Conversion Engine — Design Spec

**Sub-project 1 dari 3** dalam roadmap "Conversion + Retention + Operasional" Tiara CRM.
Sub-project lain (terurut): #2 Operator Productivity Suite, #3 Retention/Lifecycle Automation.

**Date:** 2026-05-02
**Status:** Draft — pending implementation
**Owner:** finance.parselia@gmail.com

---

## 1. Tujuan & Outcome

Owner Prestisa belum punya **visibility conversion funnel** dari conversation menjadi paid order. Saat ini:
- Bisa lihat jumlah inbound, AI cost, handover rate, tapi **tidak bisa lihat berapa deal stuck di tahap mana**.
- Tidak ada **forecast revenue** dari deal yang masih in-flight.
- Tidak ada cara mengukur **bottleneck stage** (mis. AI sering kirim form tapi customer jarang submit).
- Tidak ada **lost reason analytics** — kenapa deal gagal closing tidak ter-track.

Sales Pipeline mengisi gap ini dengan model klasik CRM: setiap conversation menjadi *deal* dengan stage yang berkembang dari `baru` ke `delivered` (atau `lost`). Stage berpindah otomatis berdasar event existing (intent classify, tool firing, MySQL order state) dengan opsi manual override.

**Success criteria:**
- Owner dapat membuka `/pipeline` dan melihat distribusi deal per stage + expected revenue dalam <2 detik.
- ≥95% transisi stage terjadi otomatis (tanpa kerja operator).
- Operator dapat manual override (drag-drop) dan set Lost reason dalam <3 klik.
- Backfill semua existing conversation ke stage yang tepat saat deploy.

---

## 2. Scope

**In scope (v1):**
- 1 conversation = 1 deal (1:1 mapping di `crm_conversations`).
- 6 stage utama + Lost (8 reason).
- Auto-transition rules + manual override (drag-drop).
- Single pipeline universal dengan `pipeline_type` attribute (papan/bouquet/parsel/cake/wedding/b2b/unknown).
- Kanban board UI di `/pipeline` + read-only badge integration di `/inbox` & `/ai-monitor`.
- Forecast (expected revenue) + conversion rate antar stage + avg time per stage.
- Lost reason taxonomy (8 reason) + free-text note.
- Backfill script untuk existing conversations.

**Out of scope (defer ke v2):**
- Multi-pipeline per kategori (separate stage definitions per type).
- Probability tuning per `pipeline_type` (saat ini hardcoded universal).
- Manual deal value input (passive only — fill dari MySQL `order.total` saat submit).
- Pre-submit deal value estimation (AI-based) — semua deal NULL value sampai order submit.
- Deal yang span multiple conversations (B2B/wedding multi-touch).
- Operator goal/quota tracking.

**Eksplisit tidak dibangun:** notification per stage transition (operator sudah punya socket events untuk message/handover).

---

## 3. Data Model

### 3.1 Extend `crm_conversations`

```sql
ALTER TABLE crm_conversations ADD COLUMN pipeline_stage varchar(32) NOT NULL DEFAULT 'baru';
ALTER TABLE crm_conversations ADD COLUMN pipeline_stage_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE crm_conversations ADD COLUMN pipeline_type varchar(16) NOT NULL DEFAULT 'unknown';
ALTER TABLE crm_conversations ADD COLUMN deal_value_idr bigint;
ALTER TABLE crm_conversations ADD COLUMN deal_order_id integer;
ALTER TABLE crm_conversations ADD COLUMN lost_reason varchar(32);
ALTER TABLE crm_conversations ADD COLUMN lost_note text;
ALTER TABLE crm_conversations ADD COLUMN manual_stage_override boolean NOT NULL DEFAULT FALSE;
ALTER TABLE crm_conversations ADD COLUMN pipeline_stage_history jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX crm_conv_pipeline_stage_idx ON crm_conversations (pipeline_stage, pipeline_stage_at DESC);
CREATE INDEX crm_conv_pipeline_type_idx ON crm_conversations (pipeline_type) WHERE pipeline_stage NOT IN ('delivered','lost');
CREATE INDEX crm_conv_deal_order_idx ON crm_conversations (deal_order_id) WHERE deal_order_id IS NOT NULL;
```

**Allowed values:**

| Field | Values |
|---|---|
| `pipeline_stage` | `baru` \| `tertarik` \| `form_dikirim` \| `order_submitted` \| `paid` \| `delivered` \| `lost` |
| `pipeline_type` | `papan` \| `bouquet` \| `parsel` \| `cake` \| `wedding` \| `b2b` \| `unknown` |
| `lost_reason` | `no_reply` \| `harga_terlalu_tinggi` \| `kompetitor` \| `produk_tidak_cocok` \| `timing_tidak_pas` \| `cancelled` \| `refund_complaint` \| `other_with_note` |

`pipeline_stage_history` JSONB array: `[{ "stage": "tertarik", "at": "2026-05-02T10:00:00Z", "by": null, "source": "auto:intent_classifier" }, ...]`

### 3.2 New table `crm_pipeline_events`

Audit trail event-level untuk replay & analytics conversion rate (perlu separate dari `pipeline_stage_history` JSONB karena query SQL lebih efisien).

```sql
CREATE TABLE crm_pipeline_events (
  id              serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  from_stage      varchar(32),
  to_stage        varchar(32) NOT NULL,
  source          varchar(48) NOT NULL,    -- auto:intent | auto:order | manual | backfill
  staff_id        integer REFERENCES staff_users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_pipeline_events_conv_idx ON crm_pipeline_events (conversation_id, created_at);
CREATE INDEX crm_pipeline_events_stage_idx ON crm_pipeline_events (to_stage, created_at DESC);
```

### 3.3 Probability constants (hardcoded di service)

```js
const STAGE_PROBABILITY = {
  baru: 0.05,
  tertarik: 0.15,
  form_dikirim: 0.35,
  order_submitted: 0.70,
  paid: 0.95,
  delivered: 1.00,
  lost: 0.00,
};
```

Hardcoded di `services/pipelineEngine.js`. Tuning di-defer ke v2 (akan dibuat tabel `crm_pipeline_settings` dengan probability per type).

---

## 4. Auto-transition Rules

Engine baru `services/pipelineEngine.js` exposes:
- `apply(client, convId, event, options) → { fromStage, toStage, applied }`
- `computeNextStage(currentStage, event, override) → string` (pure function, untuk testing)
- `computeForecast(filters) → { expectedRevenue, dealCount, byStage }`
- `computeConversionRates(days) → { 'baru→tertarik': 0.85, ... }`

### 4.1 Trigger sumber → transisi

| Event sumber | Hook lokasi | Trigger | Transisi |
|---|---|---|---|
| Conv baru dibuat | `routes/webhook.js` ingest path | First inbound to new conv | `null → baru` (default sudah set di kolom) |
| Intent classified | `services/aiAgent.js` after `gemini.classifyIntent` | confidence ≥0.6 AND intent ∈ {`order_intent`,`pricing`,`shipping`,`payment`} | `baru → tertarik` |
| Order URL sent | `services/aiTools.js#build_order_form_url` | Tool firing dengan UTM ref ter-generate | `tertarik → form_dikirim` (skip langsung dari `baru` jika perlu) |
| Form submitted | `routes/funnel.js` POST `/api/funnel/event` | event=`submitted` | `form_dikirim → order_submitted` + lookup MySQL order, isi `deal_order_id` + `deal_value_idr` |
| Order paid | `scripts/deliveryComms.js#processPaidConfirm` | MySQL `order.payment_status=paid` baru terdeteksi | `order_submitted → paid` |
| Order delivered | `scripts/deliveryComms.js#processPostDelivery` | delivery_date ≤ today AND status=paid | `paid → delivered` |
| Handover refund resolved | `routes/inbox.js` handover resolve | reason=refund | `* → lost` (lost_reason=`refund_complaint`) |
| Handover cancel resolved | sama | reason=cancel | `* → lost` (lost_reason=`cancelled`) |
| Spam-blocked | `services/spamFilter.js` (di webhook) | spam detected | `* → lost` (lost_reason=`other_with_note`, lost_note=`spam_block: <reason>`) |
| Stale no-reply | `scripts/pipelineWatcher.js` (cron 1×/jam) | 3 hari no inbound, stage∈{`tertarik`,`form_dikirim`} | `* → lost` (lost_reason=`no_reply`) |
| Stale baru | sama | 7 hari no inbound, stage=`baru` | `* → lost` (lost_reason=`no_reply`) |
| Manual drag-drop | `routes/pipeline.js` POST `/api/pipeline/conversations/:id/stage` | operator action | any → any (set `manual_stage_override=true`) |

### 4.2 `pipeline_type` auto-detection

Diset saat transisi `baru → tertarik`:

```
intent='order_intent' AND no product picker yet → 'unknown'
intent ∈ {'pricing','shipping','payment','faq'} → keep current type (default 'unknown')
catalog_picker tool fired with product → set type from product.category
build_order_form_url(product_type='papan') → set 'papan'
build_order_form_url(product_type='bouquet') → set 'bouquet'
build_order_form_url(product_type='cake') → set 'cake'
build_order_form_url(product_type='parsel') → set 'parsel'
operator manual set tag 'B2B' | 'Korporat' → set 'b2b'
operator manual set tag 'Wedding' → set 'wedding'
```

Operator dapat manual override `pipeline_type` dari sidebar di chat detail (dropdown).

### 4.3 Override semantics

`manual_stage_override = true` setelah operator drag-drop atau set lewat dropdown. Behavior:
- Auto-event yang menghasilkan stage **mundur atau sama** → no-op (skip).
- Auto-event yang menghasilkan stage **maju** (lebih tinggi di urutan) → tetap apply, reset override flag ke false.

Stage order: `baru < tertarik < form_dikirim < order_submitted < paid < delivered`. `lost` orthogonal — manual lost selalu override; auto-lost tidak override manual stage non-lost.

### 4.4 Idempotency

`pipelineEngine.apply()` cek current stage sebelum transisi. Sama-stage → no-op tapi tetap append `pipeline_stage_history` dengan `source` field (audit kapan event re-fire).

`crm_pipeline_events` insert hanya jika benar-benar terjadi transisi (from ≠ to).

---

## 5. UI Design

### 5.1 Halaman baru `/pipeline`

**Layout:** Kanban horizontal dengan 6 kolom (Lost di-collapse di bawah, klik untuk expand).

**Top bar:**
- Filter: `pipeline_type` (All/Papan/Bouquet/...), `claimed_by` (All/Me/Specific operator), `date_range` (last 7d/30d/90d/all), `tag`
- Tombol "📊 Forecast" → toggle right side panel

**Kolom header (per stage):**
```
Baru (12)
Rp - 
```
- Count deal di stage
- Sum `deal_value_idr` di stage (kalau ada)

**Card content (clickable → buka `/inbox/{id}` di tab baru):**
```
┌────────────────────┐
│ 6281xxxxxx         │
│ Budi Santoso       │
│ 🌹 bouquet         │
│ 💰 Rp 450k         │
│ 💤 2j ago          │
│ ✨ auto / 🔒 manual│
└────────────────────┘
```

**Indicator icons:**
- Type badge: 🪦 papan / 🌹 bouquet / 🎁 parsel / 🎂 cake / 💍 wedding / 🏢 b2b / ❓ unknown
- Source: ✨ auto / 🔒 manual override
- Activity: 💤 last_message_at relative time / 📨 form_sent_at jika belum submit
- Health (kalau ada): ⭐ vip / 🔥 warm / ❄ cold / ⚠ at_risk

**Drag-drop:**
- Desktop: drag-drop antar kolom (use `react-dnd` atau native HTML5 drag).
- Mobile: tap card → bottom sheet dengan dropdown stage selector.
- Drop ke `lost` → modal dropdown 8 reason + textarea note (wajib jika `other_with_note`).
- Optimistic UI + revert kalau API gagal (toast error).

**Side panel forecast (right slide-in):**
- **Expected revenue** — Σ(value × probability) untuk stage non-terminal yang punya value. Fallback "—" jika tidak ada data.
- **Realized revenue 30d** — Σ(value) untuk stage `delivered` di 30 hari terakhir.
- **Conversion rate antar stage** — bar chart vertikal:
  - baru → tertarik: 65%
  - tertarik → form_dikirim: 48%
  - form_dikirim → order_submitted: 30%
  - order_submitted → paid: 87%
  - paid → delivered: 95%
- **Avg time per stage** — list horizontal: Baru 6j · Tertarik 4j · Form Kirim 18j · ...
- **Top Lost reason 30d** — bar chart vertikal kecil dengan 5 reason terbanyak.

### 5.2 Integrasi `/inbox`

- Kolom "Stage" tambahan di list (badge warna per stage, read-only). Filter "by stage" di toolbar.
- Color mapping: baru=slate, tertarik=blue, form_dikirim=indigo, order_submitted=violet, paid=emerald, delivered=teal, lost=rose.

### 5.3 Integrasi `/inbox/[id]` chat detail

- Badge stage di chat header (sebelah indicator snooze/claim). Klik → buka `/pipeline?focus={convId}`.
- Tooltip badge: stage history mini (3 transisi terakhir).
- Section baru di CustomerPanel: "Pipeline" dengan stage saat ini, dropdown manual change stage, dropdown change `pipeline_type`, button "Mark Lost" yang buka modal reason picker.

### 5.4 Integrasi `/ai-monitor`

- Card baru "Pipeline summary":
  - Total deals active (non-terminal)
  - Expected revenue
  - Realized revenue 30d
  - Top stage with most deals
  - Conversion rate `form_dikirim → paid` (key business metric)

---

## 6. API Endpoints (baru)

Mounted di `routes/pipeline.js`, `app.use('/api/pipeline', ...)`:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/pipeline/board` | staff | List semua deal grouped by stage. Query: `type`, `claimed_by`, `tag_id`, `date_from`, `date_to`. Return: `{ stages: { baru: [card], tertarik: [card], ... }, lost: [card] }` |
| POST | `/api/pipeline/conversations/:id/stage` | staff | Manual stage change. Body: `{ stage, lost_reason?, lost_note? }`. Set `manual_stage_override=true`. |
| POST | `/api/pipeline/conversations/:id/type` | staff | Manual type change. Body: `{ type }`. |
| GET | `/api/pipeline/forecast` | staff | Return `{ expected_revenue, realized_revenue_30d, by_stage: [{stage, count, value}], conversion_rates, avg_time_per_stage_seconds, top_lost_reasons }` |
| GET | `/api/pipeline/events?conversation_id=X&limit=20` | staff | Audit history per conv |

---

## 7. Backfill Strategy

Script `scripts/pipelineBackfill.js` — jalan sekali saat deploy via `node scripts/pipelineBackfill.js`.

**Algoritma per conversation (decision tree):**

```
IF status='closed' AND ada handover reason='refund' resolved
  → stage='lost', lost_reason='refund_complaint'
ELSE IF status='closed' AND ada handover reason='cancel' resolved
  → stage='lost', lost_reason='cancelled'
ELSE IF spam_block aktif (cek crm_spam_blocks)
  → stage='lost', lost_reason='other_with_note', note='spam_block'
ELSE IF deal_order_id detected via UTM ref di MySQL order:
  IF order.payment_status='paid' AND delivery_date ≤ today
    → stage='delivered'
  ELSE IF order.payment_status='paid'
    → stage='paid'
  ELSE
    → stage='order_submitted'
ELSE IF last_order_url_sent_at IS NOT NULL
  IF last inbound > 3 days ago → stage='lost', lost_reason='no_reply'
  ELSE → stage='form_dikirim'
ELSE IF last_intent IN ('order_intent','pricing','shipping','payment')
  IF last inbound > 3 days ago → stage='lost', lost_reason='no_reply'
  ELSE → stage='tertarik'
ELSE
  IF last inbound > 7 days ago → stage='lost', lost_reason='no_reply'
  ELSE → stage='baru'
```

`pipeline_type` di-infer dari order in MySQL kalau ada (lookup `order_items.product` → category), atau dari last `last_intent` (intent classifier output), atau default `unknown`.

`pipeline_stage_history` di-set dengan single entry: `[{ stage: <inferred>, at: <last_message_at OR now>, source: 'backfill' }]`.

Insert ke `crm_pipeline_events` 1 row per conv: `from_stage=null, to_stage=<inferred>, source='backfill'`.

Batch processing: 500 conv per batch dengan COMMIT antar batch.

---

## 8. Edge Cases

1. **Conv tanpa intent jelas** — stay di `baru`. Setelah 7 hari → auto-Lost reason=`no_reply` (longer threshold karena operator mungkin belum sempat handle).
2. **CSAT digit response** — short-circuit di webhook, tidak trigger transition.
3. **AI off / shadow mode** — pipeline tetap track. Stage transition pakai event yang masih jalan (intent classifier tetap aktif).
4. **Conv re-opened setelah Lost** — kalau customer balas chat di conv `lost`, auto-reactivate ke `tertarik` (single rule). Append event `reactivated_from_lost` ke `crm_pipeline_events`. Reset `lost_reason`/`lost_note` ke null.
5. **Manual override + auto-event collision** — manual override flag *cleared* saat auto-event push ke stage maju. Mundur stage selalu butuh manual.
6. **Backfill non-determinis** — kalau backfill script tidak bisa infer (mis. conv kosong tanpa message), default `baru` dengan source `backfill_no_signal`.
7. **MySQL order tidak ditemukan** — saat funnel `submitted` event masuk tapi order belum ter-write di MySQL (race condition), retry 3× dengan backoff 5s. Kalau tetap tidak ada, log warning + tetap pindah ke `order_submitted` dengan `deal_value_idr=null`, akan di-backfill saat order muncul.
8. **Multiple orders dari satu conv** — saat ini hanya track 1 (`deal_order_id` single). Order kedua yang masuk via UTM yang sama akan **overwrite** value sebelumnya (later-wins). v2 akan handle multi-order via tabel `deals` terpisah.
9. **Customer balas di conv yang sudah `delivered`** — tidak trigger reactivation (treat as new conv yang seharusnya muncul terpisah; existing logic conversation routing tidak diubah).

---

## 9. Testing

### 9.1 Unit tests (`backend/test/pipelineEngine.test.js`)

- Pure function `computeNextStage(currentStage, event, override)`:
  - Table-driven test untuk semua 30+ kombinasi (stage × event × override).
  - Edge: same-stage transitions, backward without override, lost from any stage.
- `computeForecast(deals)`:
  - Snapshot test dengan 10 deal seed.
- `inferTypeFromIntent(intent, productType, tags)`:
  - 12 kasus.

### 9.2 Integration tests

- Backfill script di staging dataset 100 conv random — verifikasi setiap conv berakhir di stage yang benar.
- API endpoint `/api/pipeline/board` — check structure return + filter behavior.
- Manual override → forecast recompute correctly.

### 9.3 Manual smoke

End-to-end 1 conv simulasi:
1. New customer chat → verify stage=`baru` di /pipeline.
2. Customer tanya harga papan → verify stage=`tertarik`, type=`papan`.
3. AI kirim form URL → verify stage=`form_dikirim`.
4. Customer submit form (call funnel endpoint manual) → verify stage=`order_submitted`, deal_value muncul.
5. Mark order paid di MySQL → wait 15min cron → verify stage=`paid`.
6. Set delivery_date kemarin di MySQL → next cron → verify stage=`delivered`.
7. Operator drag conv lain ke `lost` reason=`kompetitor` → verify forecast update.

### 9.4 Pre-deploy verification

- Apply migration di staging
- Run backfill di staging dump
- Sample 20 conv random, verifikasi stage manual
- Compare forecast number dengan eksisting MySQL order data (sanity check — realized_revenue_30d harus matching dengan SUM order.total paid 30d)

---

## 10. Telemetri & Monitoring

- **Anomaly detector**: tambah kind `pipeline_stale_form_dikirim` — alert ke Telegram (channel `anomaly`) kalau >10 deal stuck di Form Dikirim >24 jam.
- **Daily brief**: tambah block "Pipeline today" — count by stage, expected revenue, top lost reason yesterday.
- **Cron `pipelineWatcher.js`** (1×/jam): scan stale deals → auto-Lost. Log count yang di-Lost-kan.

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| UTM tracking dari order form web rusak (tidak set utm_content) | Stage stuck di `form_dikirim`, deal_value tidak ter-fill | Pre-deploy verifikasi UTM passing benar di staging order form. Fallback: manual lookup phone match di MySQL `order` table (slower, tapi tetap match). |
| `manual_stage_override` flag tidak ter-clear saat auto-event push maju | Operator manual set ke `tertarik`, sistem tidak pernah auto-pindahkan ke `form_dikirim` | Unit test khusus untuk override + auto-forward + reset behavior. |
| Backfill script lambat untuk dataset besar (>50k conv) | Deploy delay | Batch processing 500 conv/commit + index check sebelum run. Estimasi <15 menit untuk 50k. |
| Drag-drop di mobile UX awkward | Operator tidak pakai pipeline | Mobile fallback: tap → bottom sheet dropdown (sudah di design). |
| Conv `lost` lalu customer balas → auto reactivate bisa noisy | Pipeline jadi penuh deal yang dulunya lost | Hanya reactivate kalau pesan customer adalah text non-CSAT-digit. Jika tipe spam, biarkan tetap lost. |

---

## 12. Implementation Outline

(Detail dijabarkan di implementation plan terpisah lewat skill `writing-plans`)

1. **Migration `013_pipeline.sql`** — extend `crm_conversations`, create `crm_pipeline_events`, indexes.
2. **`services/pipelineEngine.js`** — pure functions (apply, computeNextStage, computeForecast, computeConversionRates) + DB writes.
3. **Hook integrations**:
   - `routes/webhook.js` — set initial stage `baru` on conv create.
   - `services/aiAgent.js` — call `pipelineEngine.apply` after intent classify.
   - `services/aiTools.js#build_order_form_url` — call apply on tool firing.
   - `routes/funnel.js` — call apply on `submitted` event.
   - `scripts/deliveryComms.js` — call apply on paid/delivered detection.
   - `routes/inbox.js` handover resolve — call apply on refund/cancel resolved.
   - `services/spamFilter.js` — call apply on spam detected.
4. **`scripts/pipelineWatcher.js`** — cron 1×/jam, auto-Lost stale deals.
5. **`routes/pipeline.js`** — 5 API endpoints.
6. **Frontend `/pipeline` page** — kanban board + forecast panel + filters.
7. **Frontend integrasi** — inbox list badge + chat detail header + ai-monitor card + CustomerPanel section.
8. **`scripts/pipelineBackfill.js`** — one-shot backfill.
9. **Cron entry** — add `pipelineWatcher.js` ke `/etc/cron.d/crm-pilot`.
10. **Test suite** — unit tests (pipelineEngine) + integration tests (API + backfill).
11. **Anomaly detector & daily brief** — extend existing scripts dengan pipeline metrics.
12. **Smoke test end-to-end** + manual UAT 1-2 hari sebelum mark complete.
