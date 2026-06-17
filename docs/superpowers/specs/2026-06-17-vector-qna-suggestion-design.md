# Vector Q&A Suggestion (RAG) + Feedback Feeders — Design Spec

**Date:** 2026-06-17
**Project:** crm (salesai.prestisa.net)
**Status:** Approved — ready for writing-plans

## Goal

Bangun basis **Q&A vektor (RAG)**: pasangan pertanyaan customer → jawaban bagus, di-embed,
lalu saat ada pesan masuk, **retrieve Q&A paling mirip** untuk grounding saran balasan AI.
Plus 3 **feeder** yang mengisi basis Q&A dari pemakaian nyata.

## Feasibility / arsitektur (reuse, nol infra baru)

Reuse pola RAG yang sudah ada — **TANPA pgvector** (tidak terpasang di PG 15.18):
- `services/embedClient.js`: Gemini `gemini-embedding-001` (3072-dim), `embed(texts)` + `cosine(a,b)`.
- Pola `services/aiKbRag.js`: simpan embedding sebagai **JSONB** di Postgres + `embedding_hash`
  (refresh saat stale), ranking cosine di Node atas baris enabled.

## A — Foundation: Vector Q&A

### A1. Migrasi 036 — `crm_qna`
```
id bigserial PK, question text NOT NULL, answer text NOT NULL,
intent text, business_number text, source text DEFAULT 'curated',  -- curated|won|rated|imported
embedding jsonb, embedding_hash text, enabled bool DEFAULT true,
win_count int DEFAULT 0, times_served int DEFAULT 0,
created_by int, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
```
Index: `(enabled)`, `(intent)`.

### A2. Service `services/qnaRag.js` (reuse embedClient)
- `embedPending(apiKey?)` — embed baris `enabled AND (embedding IS NULL OR embedding_hash != md5(question))`.
- `retrieveSimilar(queryText, { k=3, minScore=0.72, business_number=null })` — embed query, muat
  baris enabled ber-embedding (filter brand bila diberi), cosine-rank, return top-k
  `{ id, question, answer, score }` (≥ minScore). Naikkan `times_served`.
- `upsertQna({ question, answer, intent, source, business_number, created_by })` — INSERT, embed
  inline (best-effort; kalau gagal, biarkan embedPending mengisi). Dedup ringan: kalau ada
  question identik (lower/trim) → update answer + `win_count += 1`.

### A3. Integrasi ke saran
- `services/suggestionEngine.js` (WAHA) + endpoint Lotus `ai-suggestions`/`ai-suggest-reply`:
  panggil `retrieveSimilar(inboundBody, { business_number })`. Jika ada match:
  - Sisipkan ke prompt synth: blok "Referensi Q&A yang terbukti baik (pakai sebagai acuan, jangan plagiat mentah):".
  - (Opsional) match teratas score ≥ 0.85 ditawarkan sebagai 1 opsi langsung berlabel "dari Q&A".

### A4. Admin `/qna`
- Route `backend/routes/qna.js` (admin-only): GET list (search/filter), POST create, PUT update,
  DELETE, POST `/embed-pending` (trigger). Embed saat create/update.
- Frontend `pages/qna.js` + nav item: tabel Q&A + form tambah/edit + toggle enabled.

### A5. Refresh embedding
- `embedPending` dipanggil saat create/update (inline) + ditambah ke cron harian analyst
  (atau worker ringan) agar baris dari feeder (yang masuk tanpa embedding) ter-embed.

## B — Feeders (mengisi `crm_qna`)

### B1. Auto-harvest dari saran yang menang
- Job `scripts/harvestQna.js` (dijalankan nightly via pm2 cron, mirip prewarm): cari
  `crm_suggestion_log` dengan `usage_type='raw'` pada `crm_conversations` yang `pipeline_stage`
  closing/paid (won), ambil (pesan inbound pemicu → balasan terkirim) → `upsertQna({source:'won'})`.
  Idempoten via dedup question.

### B2. Rating 👍/👎 pada saran
- Tabel sudah punya `crm_suggestion_log.flagged_reason/flagged_note`. Tambah endpoint
  `POST /api/inbox/.../suggestion/:logId/rate {vote, note}` (atau di lotus): 👍 → `upsertQna(source:'rated')`
  dari (inbound→opsi terpilih); 👎 → set `flagged_reason='bad_suggestion'`.
- Frontend: tombol 👍/👎 kecil pada tiap opsi saran (komponen suggestion yang sudah ada).

### B3. Log suggestion Lotus (sekarang kosong)
- Migrasi `crm_lotus_suggestion_log` (mirror `crm_suggestion_log` tapi key `lotus_id` + `cust_number`):
  id, lotus_id, cust_number, shown_at, options jsonb, picked_rank, usage_type, edit_distance,
  staff_id, flagged_reason, flagged_note.
- Endpoint Lotus `ai-suggestions` mencatat shown (return `log_id`); endpoint `send`/dedicated
  `suggestion/:logId/used` mencatat pemakaian. Memberi data feeder untuk Lotus.

## Decisions / defaults (didokumentasikan)
- Embedding: `gemini-embedding-001` JSONB + cosine-di-Node (pola existing). Skala menengah OK;
  pgvector = optimasi fase lain bila Q&A > ~5–10k.
- Retrieval default: top-3, minScore 0.72; opsi langsung bila ≥ 0.85. Konstanta, mudah tune.
- Harvest "won" = `pipeline_stage IN ('paid','delivered')` (WAHA). Lotus harvest menyusul setelah B3 punya data.

## Out of scope
- pgvector / ANN index (cosine-di-Node cukup utk skala awal).
- Auto-embedding re-train model (tetap RAG, bukan fine-tune).
- Moderation Q&A canggih (cukup enabled toggle + dedup).

## Testing
- `qnaRag.retrieveSimilar` ranking (mock embed) — unit test cosine ranking + minScore + dedup upsert.
- Route `/api/qna` CRUD — supertest (mock pg).
- Harvest job — unit test query builder / dedup (mock).
- Integrasi: suggestionEngine menyisipkan blok referensi saat ada match (unit test prompt contains).
- Migrasi applied; embed end-to-end diverifikasi runtime (1 Q&A → embedding terisi → retrieve match).
