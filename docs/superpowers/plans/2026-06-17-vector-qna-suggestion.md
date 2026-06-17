# Vector Q&A Suggestion + Feeders — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
**Spec:** `docs/superpowers/specs/2026-06-17-vector-qna-suggestion-design.md`. Reuse `services/embedClient.js` (embed+cosine) & pola `aiKbRag.js` (JSONB embeddings). NO pgvector.

Urutan dependensi: **Foundation Q1–Q5 dulu**, lalu **Feeders Q6–Q8**, lalu **Q9 deploy**.

---

## Q1: Migrasi 036 — crm_qna + crm_lotus_suggestion_log

**Files:** Create `backend/migrations/036_qna_vector.sql`
```sql
-- 036_qna_vector.sql
CREATE TABLE IF NOT EXISTS crm_qna (
  id            bigserial PRIMARY KEY,
  question      text NOT NULL,
  answer        text NOT NULL,
  intent        text,
  business_number text,
  source        text NOT NULL DEFAULT 'curated',  -- curated|won|rated|imported
  embedding     jsonb,
  embedding_hash text,
  enabled       boolean NOT NULL DEFAULT true,
  win_count     int NOT NULL DEFAULT 0,
  times_served  int NOT NULL DEFAULT 0,
  created_by    int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_qna_enabled_idx ON crm_qna (enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS crm_qna_intent_idx  ON crm_qna (intent);

CREATE TABLE IF NOT EXISTS crm_lotus_suggestion_log (
  id            bigserial PRIMARY KEY,
  lotus_id      text NOT NULL,
  cust_number   text,
  shown_at      timestamptz NOT NULL DEFAULT now(),
  options       jsonb NOT NULL,
  picked_rank   smallint,
  usage_type    varchar(10) CHECK (usage_type IN ('raw','edited','manual')),
  edit_distance numeric(4,3),
  staff_id      int,
  flagged_reason varchar(20),
  flagged_note  text
);
CREATE INDEX IF NOT EXISTS crm_lotus_sug_log_idx ON crm_lotus_suggestion_log (lotus_id, shown_at DESC);
```
- [ ] Step 1 tulis file. Step 2 `cd backend && npm run migrate` (terapkan 036). Step 3 verifikasi `to_regclass('crm_qna')` & `to_regclass('crm_lotus_suggestion_log')` non-null. Step 4 commit `feat(qna): migration 036 crm_qna + lotus suggestion log`.

---

## Q2: Service `qnaRag.js` (TDD)

**Files:** Create `backend/services/qnaRag.js`, `backend/__tests__/qnaRag.test.js`

Inti testable: ranking cosine + minScore + dedup upsert. Mock `embedClient` & `pg`.

- [ ] Step 1 test:
```js
// backend/__tests__/qnaRag.test.js
jest.mock('../db/postgres');
jest.mock('../services/embedClient', () => ({
  embed: jest.fn(async (arr) => arr.map(() => [1, 0, 0])),     // query vec = [1,0,0]
  cosine: jest.requireActual('../services/embedClient').cosine,
}));
const pg = require('../db/postgres');
const { retrieveSimilar } = require('../services/qnaRag');

test('retrieveSimilar ranking + minScore', async () => {
  pg.query.mockResolvedValueOnce({ rows: [
    { id: 1, question: 'harga papan?', answer: 'mulai 300rb', embedding: [1, 0, 0] },     // cosine 1.0
    { id: 2, question: 'jam buka?',     answer: 'Senin-Sabtu', embedding: [0, 1, 0] },     // cosine 0
  ] });
  pg.query.mockResolvedValueOnce({ rowCount: 1 }); // times_served update
  const out = await retrieveSimilar('berapa harga papan', { k: 3, minScore: 0.5 });
  expect(out.map((r) => r.id)).toEqual([1]);       // only id1 passes minScore
  expect(out[0].score).toBeCloseTo(1, 5);
});
```
- [ ] Step 2 `npx jest qnaRag -i` → FAIL.
- [ ] Step 3 implementasi:
```js
// backend/services/qnaRag.js
// Vector Q&A retrieval — reuse embedClient (gemini-embedding-001) + cosine.
// Embeddings disimpan JSONB di crm_qna (pola aiKbRag). Tanpa pgvector.
const pg = require('../db/postgres');
const { embed, cosine } = require('./embedClient');

async function retrieveSimilar(queryText, opts = {}) {
  const { k = 3, minScore = 0.72, business_number = null } = opts;
  const q = String(queryText || '').trim();
  if (!q) return [];
  const [qVec] = await embed([q]);
  if (!qVec || !qVec.length) return [];
  const params = [];
  let where = `enabled = true AND embedding IS NOT NULL`;
  if (business_number) { params.push(business_number); where += ` AND (business_number IS NULL OR business_number = $${params.length})`; }
  const { rows } = await pg.query(`SELECT id, question, answer, embedding FROM crm_qna WHERE ${where}`, params);
  const ranked = rows
    .map((r) => ({ id: r.id, question: r.question, answer: r.answer, score: Array.isArray(r.embedding) ? cosine(qVec, r.embedding) : 0 }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (ranked.length) {
    await pg.query(`UPDATE crm_qna SET times_served = times_served + 1 WHERE id = ANY($1::bigint[])`, [ranked.map((r) => r.id)]).catch(() => {});
  }
  return ranked;
}

async function upsertQna({ question, answer, intent = null, source = 'curated', business_number = null, created_by = null }) {
  if (!question || !answer) return null;
  const { rows: ex } = await pg.query(`SELECT id FROM crm_qna WHERE lower(trim(question)) = lower(trim($1)) LIMIT 1`, [question]);
  if (ex[0]) {
    await pg.query(`UPDATE crm_qna SET answer = $2, win_count = win_count + 1, updated_at = now(), embedding = NULL, embedding_hash = NULL WHERE id = $1`, [ex[0].id, answer]);
    return ex[0].id;
  }
  const { rows } = await pg.query(
    `INSERT INTO crm_qna (question, answer, intent, source, business_number, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [question, answer, intent, source, business_number, created_by]
  );
  return rows[0].id;
}

async function embedPending(limit = 200) {
  const { rows } = await pg.query(
    `SELECT id, question FROM crm_qna
      WHERE enabled = true AND (embedding IS NULL OR embedding_hash IS NULL OR embedding_hash != md5(question))
      LIMIT $1`, [limit]
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.question));
  for (let i = 0; i < rows.length; i++) {
    await pg.query(`UPDATE crm_qna SET embedding = $2::jsonb, embedding_hash = md5(question), updated_at = now() WHERE id = $1`,
      [rows[i].id, JSON.stringify(vecs[i])]);
  }
  return rows.length;
}

module.exports = { retrieveSimilar, upsertQna, embedPending };
```
- [ ] Step 4 `npx jest qnaRag -i` → PASS. Step 5 commit `feat(qna): qnaRag retrieve/upsert/embedPending service with tests`.

---

## Q3: Route `/api/qna` (CRUD) + mount

**Files:** Create `backend/routes/qna.js`, `backend/__tests__/qna.route.test.js`; Modify `backend/index.js`

Admin-only (pola supervisor.js). Endpoints: `GET /` (list, optional `q` search), `POST /` (create→embed), `PUT /:id`, `DELETE /:id`, `POST /embed-pending`.
- [ ] Step 1 test (supertest + mock pg + mock qnaRag.embedPending): create returns id; non-admin 403; list returns items.
- [ ] Step 2 FAIL. Step 3 implement route memakai `pg` langsung untuk list/update/delete dan `qnaRag.upsertQna`+`embedPending` untuk create. (Lihat pola admin-guard + pg di `routes/supervisor.js`.) Mount di index.js: `app.use('/api/qna', require('./routes/qna'))`.
- [ ] Step 4 PASS. Step 5 commit `feat(qna): admin CRUD route /api/qna`.

---

## Q4: Frontend `/qna` admin page + nav

**Files:** Create `frontend/src/pages/qna.js`; Modify `frontend/src/components/Layout.jsx`
- [ ] Nav item `{ href: '/qna', label: 'Q&A AI', icon: '💡', adminOnly: true }` setelah `/knowledge`.
- [ ] Page: SWR list `/api/qna`, tabel (question, answer, source, enabled, times_served), form tambah (question+answer+intent), tombol simpan (POST), toggle enabled (PUT), hapus (DELETE), tombol "Embed pending". Pola sama `reply-templates.js`/`knowledge.js`. Build hijau. Commit `feat(qna): admin /qna page + nav`.

---

## Q5: Integrasi retrieve ke saran

**Files:** Modify `backend/services/suggestionEngine.js`; Modify Lotus `ai-suggestions`/`ai-suggest-reply` di `backend/routes/lotusInbox.js`
- [ ] READ suggestionEngine.js: temukan tempat membangun prompt AI synth. Sebelum generate, `const refs = await require('./qnaRag').retrieveSimilar(inboundBody, { business_number })`. Jika `refs.length`, sisipkan ke prompt: `\nReferensi Q&A terbukti baik (acuan, jangan plagiat mentah):\n` + refs.map(r=>`Q: ${r.question}\nA: ${r.answer}`).join('\n---\n'). Test: unit (mock qnaRag) memastikan prompt builder menyertakan blok saat ada refs. (Jika prompt dibangun inline susah diuji, ekstrak builder kecil.)
- [ ] Lotus `ai-suggestions`/`ai-suggest-reply`: panggil retrieveSimilar(inbound, {business_number}) dan inject sama ke prompt synth-nya.
- [ ] Verifikasi tidak merusak alur (test suggestion lama, jika ada, tetap hijau). Commit `feat(qna): inject retrieved Q&A into reply suggestion prompts`.

---

## Q6 (Feeder B1): Harvest job

**Files:** Create `backend/scripts/harvestQna.js`; Modify `ecosystem.config.js`
- [ ] Job: cari `crm_suggestion_log sl JOIN crm_conversations c ON c.id=sl.conversation_id` dengan `sl.usage_type='raw'` dan `c.pipeline_stage IN ('paid','delivered')`, ambil pesan inbound pemicu (`sl.inbound_msg_id` → crm_messages.body) sebagai question dan opsi terkirim (`sl.options->picked_rank` atau `sl.sent_msg_id` body) sebagai answer → `qnaRag.upsertQna({source:'won'})`. Idempoten (dedup question di upsert). Lalu `embedPending()`. Cap 500/run.
- [ ] pm2 cron entry `crm-qna-harvest` `cron_restart: '30 2 * * *'` (setelah analyst prewarm), autorestart:false. Commit `feat(qna): nightly harvest won raw-used replies into Q&A`.

---

## Q7 (Feeder B2): Rating 👍/👎

**Files:** Modify suggestion log writer + endpoint; Modify frontend suggestion component
- [ ] Endpoint `POST /api/inbox/conversations/:id/suggestion/:logId/rate` (dan padanan Lotus) `{ vote: 'up'|'down', note }`: `up` → ambil (inbound question, opsi terpilih answer) dari crm_suggestion_log → `qnaRag.upsertQna({source:'rated'})`; `down` → `UPDATE crm_suggestion_log SET flagged_reason='bad_suggestion', flagged_note=$note`. Test supertest (mock).
- [ ] Frontend: tombol 👍/👎 kecil pada tiap opsi saran di komponen suggestion (inbox + lotus). Build hijau. Commit `feat(qna): thumbs up/down on suggestions feeds Q&A`.

---

## Q8 (Feeder B3): Log suggestion Lotus

**Files:** Modify `backend/routes/lotusInbox.js` (`ai-suggestions`)
- [ ] Saat menghasilkan opsi di `ai-suggestions` Lotus: INSERT `crm_lotus_suggestion_log (lotus_id, cust_number, options)` → kembalikan `log_id` ke frontend. Endpoint `POST /contacts/:lotus_id/suggestion/:logId/used { picked_rank, usage_type, edit_distance }` mencatat pemakaian. (Memberi data feeder + memungkinkan harvest Lotus nanti.)
- [ ] Test ringan + commit `feat(qna): persist Lotus suggestion log (shown + used)`.

---

## Q9: Deploy + verifikasi end-to-end

- [ ] `cd backend && npx jest qnaRag qna.route -i` → hijau; `pm2 restart crm-pilot-backend crm-pilot-frontend`.
- [ ] Seed 1 Q&A via `/qna` (atau node), `embedPending`, lalu `retrieveSimilar('pertanyaan mirip')` → match. Bukti end-to-end (embedding terisi + retrieve).
- [ ] Smoke: `/qna` admin tampil; buka saran balasan → blok referensi Q&A muncul saat ada match; 👍 → Q&A bertambah.

---

## Self-Review
- Foundation (Q1–Q5) self-contained & bernilai sendiri; Feeders (Q6–Q8) mengisi crm_qna; deploy Q9.
- Reuse embedClient/JSONB/cosine — nol infra baru. Konstanta retrieval (k=3, minScore .72) mudah tune.
- Catatan: cosine-di-Node atas semua baris enabled — OK utk skala awal; pgvector = optimasi fase lain bila > ~5–10k Q&A (log peringatan bila count besar).
