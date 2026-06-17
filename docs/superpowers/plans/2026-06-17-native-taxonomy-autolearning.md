# Native Taxonomy + Auto-Learning — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Spec:** `docs/superpowers/specs/2026-06-17-native-taxonomy-autolearning-design.md`. Additive — jangan ubah field Tier A lain.

---

## Task T1: Taxonomy validation (analystTaxonomy.js) — TDD

**Files:** Modify `backend/services/analystTaxonomy.js`; Create `backend/__tests__/analystTaxonomy.stuck.test.js`

- [ ] **Step 1: Test (gagal)**
```js
// backend/__tests__/analystTaxonomy.stuck.test.js
const { validateTierAOutput, ENUMS } = require('../services/analystTaxonomy');
test('stuck_group enum ada', () => {
  expect(ENUMS.stuck_group).toEqual(['customer', 'sales', 'offer', 'proses']);
});
test('validateTierAOutput memuat stuck_group + stuck_issue', () => {
  const r = validateTierAOutput({ customer_reason: 'harga_terlalu_mahal', stuck_group: 'customer', stuck_issue: 'keberatan harga', confidence: 'high' });
  expect(r.stuck_group).toBe('customer');
  expect(r.stuck_issue).toBe('keberatan harga');
});
test('stuck_group invalid → null; stuck_issue non-string → null', () => {
  const r = validateTierAOutput({ stuck_group: 'xxx', stuck_issue: 123, confidence: 'low' });
  expect(r.stuck_group).toBeNull();
  expect(r.stuck_issue).toBeNull();
});
```
- [ ] **Step 2:** `cd backend && npx jest analystTaxonomy.stuck -i` → FAIL.
- [ ] **Step 3:** Di `backend/services/analystTaxonomy.js`:
  - Dalam objek `ENUMS`, tambahkan setelah `customer_reason: [...]`:
    ```js
    stuck_group: ['customer', 'sales', 'offer', 'proses'],
    ```
  - Dalam `validateTierAOutput` return object, tambahkan setelah baris `evidence_quote: ...`:
    ```js
    stuck_group:                     validEnum('stuck_group', raw.stuck_group),
    stuck_issue:                     typeof raw.stuck_issue === 'string' ? raw.stuck_issue.slice(0, 80) : null,
    ```
    (pastikan koma sebelumnya benar.)
- [ ] **Step 4:** `npx jest analystTaxonomy.stuck -i` → PASS.
- [ ] **Step 5:** commit:
```bash
cd /home/krttpt/crm && git add backend/services/analystTaxonomy.js backend/__tests__/analystTaxonomy.stuck.test.js && git commit -m "feat(taxonomy): native stuck_group + stuck_issue validation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T2: Prompt + corrections injection (analystReport.js) — TDD

**Files:** Modify `backend/services/analystReport.js`; Create `backend/__tests__/analystReportPrompt.test.js`

`buildTierAUserPrompt` saat ini menerima `{ transcript, msgCount, inboundCount }`. Tambah `corrections`.

- [ ] **Step 1: Test (gagal)** — export `buildTierAUserPrompt` jika belum diekspor (lihat Step 3).
```js
// backend/__tests__/analystReportPrompt.test.js
const { buildTierAUserPrompt } = require('../services/analystReport');
test('prompt memuat field stuck_group + stuck_issue', () => {
  const p = buildTierAUserPrompt({ transcript: 'x', msgCount: 5, inboundCount: 4 });
  expect(p).toMatch(/stuck_group/);
  expect(p).toMatch(/stuck_issue/);
  expect(p).toMatch(/customer.*sales.*offer.*proses/s);
});
test('corrections disisipkan saat diberikan', () => {
  const p = buildTierAUserPrompt({ transcript: 'x', msgCount: 5, inboundCount: 4, corrections: [{ to: 'harga_terlalu_mahal', reason: 'budget kecil' }] });
  expect(p).toMatch(/KOREKSI SUPERVISOR/i);
  expect(p).toMatch(/harga_terlalu_mahal/);
});
test('tanpa corrections tidak ada blok koreksi', () => {
  const p = buildTierAUserPrompt({ transcript: 'x', msgCount: 5, inboundCount: 4 });
  expect(p).not.toMatch(/KOREKSI SUPERVISOR/i);
});
```
- [ ] **Step 2:** `npx jest analystReportPrompt -i` → FAIL.
- [ ] **Step 3: Edit `backend/services/analystReport.js`:**
  - Ubah signature: `function buildTierAUserPrompt({ transcript, msgCount, inboundCount, corrections })`.
  - Tepat sebelum `return \`Analisa transkrip...`, bangun blok koreksi:
    ```js
    const corrBlock = Array.isArray(corrections) && corrections.length
      ? `\nKOREKSI SUPERVISOR DARI LAPANGAN (pelajari pola ini saat menilai):\n` +
        corrections.slice(0, 15).map((c) => `- root cause sebenarnya: ${c.to}${c.reason ? ` (alasan: ${c.reason})` : ''}`).join('\n') + '\n'
      : '';
    ```
  - Di dalam template, setelah daftar `customer_reason` (baris berisi `... | lainnya`), sisipkan blok instruksi baru:
    ```
    stuck_group — grup issue lead yang belum closing (null kalau tidak stuck / sudah closing):
    "customer" | "sales" | "offer" | "proses"
    stuck_issue — sub-issue spesifik (1 frasa pendek), contoh per grup:
    customer: tanya harga / belum ada tanggal jelas / bandingkan vendor / belum balas setelah quotation / keberatan harga / menunggu approval / belum yakin desain
    sales: kurang gali kebutuhan / terlalu cepat kirim harga / belum jelaskan value / salah rekomendasi / belum opsi Good-Better-Best / belum urgency / follow up pasif / tidak tangkap buying signal
    offer: produk tidak sesuai / harga tidak masuk budget / desain kurang cocok / area-waktu kirim kendala / promo kurang menarik / tidak ada alternatif
    proses: belum FU sesuai cycle / response time lama / quotation belum dikirim / bukti desain belum dikirim / perlu eskalasi supervisor
    ```
  - Di contoh JSON output, tambahkan 2 baris sebelum `"evidence_quote"`:
    ```
    "stuck_group": "customer" | "sales" | "offer" | "proses" | null,
    "stuck_issue": "<frasa pendek>" | null,
    ```
  - Sisipkan `${corrBlock}` tepat sebelum baris `Transkrip (${msgCount}...`.
  - Ubah `runTierA` signature: `async function runTierA({ transcript, msgCount, inboundCount, geminiKey, corrections })` dan panggil `buildTierAUserPrompt({ transcript, msgCount, inboundCount, corrections })`.
  - Pastikan `module.exports` menyertakan `buildTierAUserPrompt` (tambahkan jika belum).
- [ ] **Step 4:** `npx jest analystReportPrompt -i` → PASS.
- [ ] **Step 5:** commit:
```bash
cd /home/krttpt/crm && git add backend/services/analystReport.js backend/__tests__/analystReportPrompt.test.js && git commit -m "feat(taxonomy): Tier A prompt outputs stuck_group/stuck_issue + supervisor corrections injection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T3: Migration 035

**Files:** Create `backend/migrations/035_stuck_taxonomy.sql`

- [ ] **Step 1:** tulis:
```sql
-- 035_stuck_taxonomy.sql
ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS stuck_group text,
  ADD COLUMN IF NOT EXISTS stuck_issue text;
```
- [ ] **Step 2:** `cd backend && npm run migrate` → menerapkan 035.
- [ ] **Step 3:** verifikasi: `node -e "const pg=require('./db/postgres');(async()=>{const r=await pg.query(\"select string_agg(column_name,',') c from information_schema.columns where table_name='crm_lotus_state' and column_name in ('stuck_group','stuck_issue')\");console.log(r.rows[0].c);await pg.end()})()"` → `stuck_group,stuck_issue` (urutan bebas).
- [ ] **Step 4:** commit:
```bash
cd /home/krttpt/crm && git add backend/migrations/035_stuck_taxonomy.sql && git commit -m "feat(taxonomy): migration 035 stuck_group/stuck_issue columns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T4: Helpers + revise_ai override + panel native — (supervisorControl.js) TDD

**Files:** Create `backend/services/stuckGroup.js` + test; Modify `backend/routes/supervisorControl.js`

- [ ] **Step 1: Pure helper `stuckGroup.js` + test**
```js
// backend/__tests__/stuckGroup.test.js
const { STUCK_GROUP_OF, bucketOfGroup } = require('../services/stuckGroup');
test('root cause → group', () => {
  expect(STUCK_GROUP_OF('harga_terlalu_mahal')).toBe('customer');
  expect(STUCK_GROUP_OF('respon_lambat')).toBe('sales');
  expect(STUCK_GROUP_OF('area_pengiriman')).toBe('offer');
  expect(STUCK_GROUP_OF('lainnya')).toBe('proses');
});
test('group → bucket', () => {
  expect(bucketOfGroup('customer')).toBe('A');
  expect(bucketOfGroup('sales')).toBe('B');
  expect(bucketOfGroup('offer')).toBe('C');
  expect(bucketOfGroup('proses')).toBe('D');
});
```
```js
// backend/services/stuckGroup.js
const GROUP_MAP = {
  harga_terlalu_mahal: 'customer', window_shopping: 'customer', kompetitor: 'customer', ragu_kredibilitas: 'customer',
  respon_lambat: 'sales', info_produk_kurang: 'sales',
  barang_tidak_tersedia: 'offer', ekspektasi_design: 'offer', area_pengiriman: 'offer', timing_pengiriman: 'offer',
};
const BUCKET = { customer: 'A', sales: 'B', offer: 'C', proses: 'D' };
function STUCK_GROUP_OF(rc) { return GROUP_MAP[rc] || 'proses'; }
function bucketOfGroup(g) { return BUCKET[g] || null; }
module.exports = { STUCK_GROUP_OF, bucketOfGroup, GROUP_MAP, BUCKET };
```
Run `npx jest stuckGroup -i` → PASS.

- [ ] **Step 2: revise_ai immediate override.** Di `backend/routes/supervisorControl.js`, import `const { STUCK_GROUP_OF } = require('../services/stuckGroup');`. Di handler `POST /lead/:lotus_id/action`, di dalam blok yang menangani aksi, SETELAH insert log, tambahkan: jika `action === 'revise_ai'` dan `corrected_root_cause`, jalankan:
```js
    if (action === 'revise_ai' && corrected_root_cause) {
      await pg.query(
        `UPDATE crm_lotus_state SET root_cause_tag = $2, stuck_group = $3, stuck_issue = COALESCE($4, stuck_issue) WHERE lotus_id = $1`,
        [lotus_id, corrected_root_cause, STUCK_GROUP_OF(corrected_root_cause), corrected_reason || null]
      );
    }
```

- [ ] **Step 3: Panel pakai native stuck_group.** Di handler `/panel`, import `const { bucketOfGroup } = require('../services/stuckGroup');`. Di loop perakitan item, setelah `const cls = classify(lead);`, tambahkan override:
```js
      let stuck_bucket = cls.stuck_bucket, stuck_label = cls.stuck_label, groups = cls.groups;
      if (s.stuck_group) {
        stuck_bucket = bucketOfGroup(s.stuck_group);
        stuck_label = s.stuck_issue || s.stuck_group;
        if (!groups.includes('lead_stuck')) groups = [...groups, 'lead_stuck'];
      }
```
Lalu pada `items.push({...})`, ganti `groups: cls.groups, stuck_bucket: cls.stuck_bucket, stuck_label: cls.stuck_label` menjadi `groups, stuck_bucket, stuck_label`.

- [ ] **Step 4:** Jalankan `npx jest stuckGroup supervisorControlPanel supervisorControl -i` → PASS (test panel lama tetap hijau).
- [ ] **Step 5:** commit:
```bash
cd /home/krttpt/crm && git add backend/services/stuckGroup.js backend/__tests__/stuckGroup.test.js backend/routes/supervisorControl.js && git commit -m "feat(taxonomy): revise_ai override + panel uses native stuck_group

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T5: Storage + corrections wiring (cron + endpoint)

**Files:** Modify `backend/cron_analyst_tier_a_prewarm.js`, `backend/routes/lotusInbox.js`

- [ ] **Step 1: cron storage + backfill + corrections.** Di `cron_analyst_tier_a_prewarm.js`:
  - `findTargets`: ubah subquery `done` agar HANYA menganggap selesai bila `analyst_report_generated_at IS NOT NULL AND stuck_group IS NOT NULL` — yakni ubah query menjadi:
    `... WHERE lotus_id = ANY($1::text[]) AND analyst_report_generated_at IS NOT NULL AND stuck_group IS NOT NULL`.
    (Sehingga lead lama tanpa stuck_group ikut di-backfill.)
  - Sebelum loop, ambil corrections sekali:
    ```js
    const corrections = (await pg.query(
      `SELECT corrected_root_cause AS to, corrected_reason AS reason FROM crm_lead_supervisor_actions
       WHERE action='revise_ai' AND corrected_root_cause IS NOT NULL ORDER BY created_at DESC LIMIT 15`
    )).rows;
    ```
  - Panggil `runTierA({ transcript, msgCount, inboundCount, geminiKey: process.env.GEMINI_API_KEY, corrections })`.
  - Di INSERT `crm_lotus_state`, tambahkan kolom `stuck_group, stuck_issue` dan value `validated.stuck_group, validated.stuck_issue`; dan di `ON CONFLICT ... DO UPDATE SET` tambahkan `stuck_group = EXCLUDED.stuck_group, stuck_issue = EXCLUDED.stuck_issue`.
- [ ] **Step 2: endpoint storage + corrections.** Di `backend/routes/lotusInbox.js` handler `POST /contacts/:lotus_id/analyst-report` (Tier A path): ambil corrections (query sama seperti di cron) dan teruskan ke `runTierA`; simpan `stuck_group`/`stuck_issue` ke `crm_lotus_state` (tambahkan ke INSERT/UPDATE set yang sudah ada di handler). Baca handler dulu untuk menemukan query simpannya.
- [ ] **Step 3: Verifikasi load** `node -e "require('./cron_analyst_tier_a_prewarm.js')"` tidak error sintaks (jangan sampai jalan penuh — bungkus? cukup `node --check`):
  Run: `cd backend && node --check cron_analyst_tier_a_prewarm.js && node --check routes/lotusInbox.js` → tanpa error.
- [ ] **Step 4: Seluruh test backend regresi** `npx jest -i 2>&1 | tail -5` → suite taxonomy/panel/stuck hijau (suite pre-existing yg gagal diabaikan).
- [ ] **Step 5:** commit:
```bash
cd /home/krttpt/crm && git add backend/cron_analyst_tier_a_prewarm.js backend/routes/lotusInbox.js && git commit -m "feat(taxonomy): store stuck_group/issue + inject corrections in cron & endpoint + backfill missing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task T6: Deploy + trigger backfill

- [ ] **Step 1:** `pm2 restart crm-pilot-backend` → online.
- [ ] **Step 2:** Trigger backfill sekarang (mengisi stuck_group lead lama; cap 1000):
  Run: `pm2 restart crm-analyst-prewarm` (one-shot; akan jalan & exit). Pantau:
  `pm2 logs crm-analyst-prewarm --lines 6 --nostream`.
- [ ] **Step 3:** Setelah beberapa menit, verifikasi terisi:
  `cd backend && node -e "const pg=require('./db/postgres');(async()=>{const r=await pg.query(\"select count(*) filter (where stuck_group is not null) n, count(*) t from crm_lotus_state where analyst_report_generated_at is not null\");console.log(r.rows[0]);await pg.end()})()"`
- [ ] **Step 4:** Smoke: `https://salesai.prestisa.net/supervisor-control` → Grup 3 sub-issue lebih spesifik; Revisi Analisa AI → langsung berubah.

---

## Self-Review
- Additive: field Tier A lama tak diubah; 2 field baru + prompt block. ✓
- Auto-learning: (a) revise_ai override langsung (T4) + (b) corrections few-shot ke prompt (T2/T5). ✓
- Backfill bertahap via cron (stuck_group IS NULL), cost-bounded 1000/run. ✓
- Konsistensi: stuck_group enum sama di taxonomy/prompt/stuckGroup; bucket map konsisten.
