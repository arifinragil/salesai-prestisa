# Lotus Follow-Up Tracking (Sub-proyek B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Lacak status FU per lead Lotus (cadence H+1/H+3/H+5 dari `first_inbound_at`, selesai = ada pesan keluar setelah due), tampilkan banner "FU overdue" akurat + filter `fu_overdue`. Computed-only, tanpa tabel/cron/migrasi.

**Architecture:** Modul murni `services/lotusFollowup.js` (unit-tested) menghitung status FU dari `first_inbound_at` + `last_outbound_at`. Route `/contacts` & `/tab-counts` menyediakan `last_outbound_at` (LATERAL) + filter/counts `fu_overdue`/`fu_pending`. Frontend menyalakan banner FU asli + tab `fu_overdue`.

**Tech Stack:** Node/Express (dua DB), Jest + supertest, Next.js + Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-17-lotus-followup-tracking-design.md`

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `backend/services/lotusFollowup.js` (create) | Modul murni `followupState` + konstanta cadence |
| `backend/__tests__/lotusFollowup.test.js` (create) | Unit test modul |
| `backend/routes/lotusInbox.js` (modify) | `last_outbound_at` (LATERAL) di `/contacts` & `/tab-counts`; filter `fu_overdue`; counts `fu_overdue`/`fu_pending` |
| `backend/__tests__/lotusKanban.test.js` (modify) | Test filter `fu_overdue` + fu counts |
| `frontend/src/components/lotus-inbox/TabStrip.jsx` (modify) | Tambah tab `fu_overdue` |
| `frontend/src/components/lotus-inbox/TodayTasksCard.jsx` (modify) | Banner FU overdue asli |

---

## Task B1: Modul murni `lotusFollowup.js` (TDD)

**Files:**
- Create: `backend/services/lotusFollowup.js`
- Test: `backend/__tests__/lotusFollowup.test.js`

- [ ] **Step 1: Tulis test yang gagal**

```js
// backend/__tests__/lotusFollowup.test.js
const { followupState, FU_CYCLES, FU_CAP_DAYS } = require('../services/lotusFollowup');

const NOW = new Date('2026-06-17T00:00:00Z');
const DAY = 24 * 3600 * 1000;
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY).toISOString();

describe('followupState', () => {
  test('tanpa first_inbound_at → fresh, in_fu false', () => {
    const s = followupState({ first_inbound_at: null, last_outbound_at: null }, NOW);
    expect(s.status).toBe('fresh');
    expect(s.in_fu).toBe(false);
  });

  test('lead < H+1 → fresh, next_due_at terisi', () => {
    const s = followupState({ first_inbound_at: daysAgo(0.5), last_outbound_at: null }, NOW);
    expect(s.status).toBe('fresh');
    expect(s.current_cycle).toBe(0);
    expect(s.next_due_at).not.toBeNull();
  });

  test('lead H+2 tanpa pesan keluar → overdue (cycle 1)', () => {
    const s = followupState({ first_inbound_at: daysAgo(2), last_outbound_at: null }, NOW);
    expect(s.status).toBe('overdue');
    expect(s.current_cycle).toBe(1);
    expect(s.overdue_since).not.toBeNull();
  });

  test('lead H+2, sales kirim setelah H+1 → pending (cycle ini selesai)', () => {
    const s = followupState({ first_inbound_at: daysAgo(2), last_outbound_at: daysAgo(0.5) }, NOW);
    expect(s.status).toBe('pending');
    expect(s.current_cycle).toBe(1);
  });

  test('lead H+6, semua cycle dijawab → done', () => {
    const s = followupState({ first_inbound_at: daysAgo(6), last_outbound_at: daysAgo(0.1) }, NOW);
    expect(s.status).toBe('done');
    expect(s.current_cycle).toBe(3);
  });

  test('lead H+10 tanpa FU → expired (lewat cap)', () => {
    const s = followupState({ first_inbound_at: daysAgo(10), last_outbound_at: null }, NOW);
    expect(s.status).toBe('expired');
    expect(s.in_fu).toBe(false);
  });

  test('konstanta cadence', () => {
    expect(FU_CYCLES).toEqual([1, 3, 5]);
    expect(FU_CAP_DAYS).toBe(7);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest lotusFollowup -i`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementasi modul**

```js
// backend/services/lotusFollowup.js
// Logika murni FU tracking Lotus: hitung status follow-up satu lead dari
// first_inbound_at (anchor) + last_outbound_at (deteksi 'sudah di-FU'). Tanpa DB.

const FU_CYCLES = [1, 3, 5];   // hari: H+1, H+3, H+5
const FU_CAP_DAYS = 7;         // lewat ini → expired (urusan data-pending)
const DAY_MS = 24 * 3600 * 1000;

function asMs(v) { const t = (v instanceof Date ? v : new Date(v)).getTime(); return Number.isNaN(t) ? null : t; }

function followupState(item, now) {
  const nowMs = asMs(now);
  const anchor = item.first_inbound_at != null ? asMs(item.first_inbound_at) : null;
  if (anchor == null) {
    return { in_fu: false, current_cycle: 0, status: 'fresh', next_due_at: null, overdue_since: null };
  }
  const dues = FU_CYCLES.map((d) => anchor + d * DAY_MS);
  const cap = anchor + FU_CAP_DAYS * DAY_MS;
  const current_cycle = dues.filter((d) => d <= nowMs).length;
  const nextDueMs = dues.find((d) => d > nowMs);
  const next_due_at = nextDueMs ? new Date(nextDueMs) : null;

  if (current_cycle === 0) {
    return { in_fu: true, current_cycle: 0, status: 'fresh', next_due_at, overdue_since: null };
  }

  const lastDue = dues[current_cycle - 1];
  const lastOut = item.last_outbound_at != null ? asMs(item.last_outbound_at) : null;
  const done = lastOut != null && lastOut >= lastDue;

  if (nowMs > cap && !done) {
    return { in_fu: false, current_cycle, status: 'expired', next_due_at: null, overdue_since: new Date(lastDue) };
  }
  if (done) {
    const status = current_cycle === FU_CYCLES.length ? 'done' : 'pending';
    return { in_fu: true, current_cycle, status, next_due_at, overdue_since: null };
  }
  return { in_fu: true, current_cycle, status: 'overdue', next_due_at, overdue_since: new Date(lastDue) };
}

module.exports = { followupState, FU_CYCLES, FU_CAP_DAYS };
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest lotusFollowup -i`
Expected: PASS semua.

- [ ] **Step 5: Commit**

```bash
git add backend/services/lotusFollowup.js backend/__tests__/lotusFollowup.test.js
git commit -m "feat(lotus-fu): pure followupState module with tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task B2: Backend — `last_outbound_at`, filter `fu_overdue`, fu counts

**Files:**
- Modify: `backend/routes/lotusInbox.js`
- Test: `backend/__tests__/lotusKanban.test.js`

Konteks: `/contacts` query punya LATERAL `lcs` (last outbound, select `cs_name`) sekitar baris 117–125. `/tab-counts` query punya LATERAL `lm` (last message). `tabsForItem` sudah di-import.

- [ ] **Step 1: Tambah test yang gagal**

```js
// tambahkan di backend/__tests__/lotusKanban.test.js
describe('FU overdue (filter + counts)', () => {
  const dAgo = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();

  test('?tab=fu_overdue hanya lead yang FU-nya overdue', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'outbound', last_message_at: dAgo(2) },
        { lotus_id: 'B', cust_number: '2', last_message_from: 'inbound',  last_message_at: dAgo(0.1) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(2) },  // H+2, no outbound after H+1 → overdue
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(0.2) }, // baru → fresh
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=fu_overdue');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('/tab-counts memuat fu_overdue & fu_pending', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'outbound', last_message_at: dAgo(2) },
        { lotus_id: 'B', cust_number: '2', last_message_from: 'inbound',  last_message_at: dAgo(0.1) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(2) },
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7, first_inbound_at: dAgo(0.2) },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/tab-counts');
    expect(res.body.counts).toHaveProperty('fu_overdue', 1);
    expect(res.body.counts).toHaveProperty('fu_pending');
    expect(res.body.counts.fu_pending).toBeGreaterThanOrEqual(1);
  });
});
```

Catatan: mock `stubData` mengembalikan baris yang sama untuk SEMUA pemanggilan `lotus.query`/`pg.query`. Karena handler memetakan `last_outbound_at` dari kolom hasil query, sertakan field itu lewat stub bila perlu — tapi test di atas mengandalkan handler menurunkan `last_outbound_at` dari lateral; pada mock, `last_outbound_at` tidak ada di baris stub sehingga = null. Untuk lead 'A' (overdue): `first_inbound_at = H-2`, `last_outbound_at = null` → `last_outbound < H+1` → overdue. ✓ (Tidak perlu menstub `last_outbound_at`.)

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest lotusKanban -i -t "FU overdue"`
Expected: FAIL.

- [ ] **Step 3: Import modul**

Di `backend/routes/lotusInbox.js`, dekat `const { tabsForItem } = require('../services/lotusTabs');` tambahkan:

```js
const { followupState } = require('../services/lotusFollowup');
```

- [ ] **Step 4: `/contacts` — sediakan `last_outbound_at`**

Ubah LATERAL `lcs` agar ikut ambil `received_at`, dan tambah ke outer SELECT. Yakni:
- Pada baris `SELECT cs_name` di dalam lateral `lcs`, ubah jadi `SELECT cs_name, received_at`.
- Pada outer SELECT, setelah `lcs.cs_name AS last_outbound_cs`, tambahkan `, lcs.received_at AS last_outbound_at`.

Lalu di item shape (blok `// CRM state overlay:` tetangga field K2), tambahkan field non-state (taruh dekat `last_inbound_at`):
```js
      last_outbound_at: c.last_outbound_at || null,
```

- [ ] **Step 5: `/contacts` — filter `fu_overdue`**

Di blok `.filter((it) => { ... })`, GANTI baris tab-match tunggal:
```js
    // Tab match (all = semua active dalam scope)
    if (tab && tab !== 'all' && !tabsForItem(it, new Date()).includes(tab)) return false;
    return true;
```
menjadi:
```js
    // Tab match (all = semua active dalam scope). fu_overdue dihitung via followupState.
    if (tab === 'fu_overdue') {
      if (followupState(it, new Date()).status !== 'overdue') return false;
    } else if (tab && tab !== 'all' && !tabsForItem(it, new Date()).includes(tab)) {
      return false;
    }
    return true;
```

- [ ] **Step 6: `/tab-counts` — last_outbound_at + fu counts**

Di query `/tab-counts`, tambahkan LATERAL kedua untuk last outbound dan kolomnya:
- Setelah lateral `lm ON true`, tambahkan:
```js
     LEFT JOIN LATERAL (
       SELECT received_at
       FROM messages m
       WHERE m.cust_number = r.cust_number AND m.direction = 'outbound'
       ORDER BY received_at DESC NULLS LAST, id DESC
       LIMIT 1
     ) lo ON true
```
- Pada outer SELECT `/tab-counts`, tambahkan `, lo.received_at AS last_outbound_at` setelah `... AS last_message_at`.

Lalu di handler `/tab-counts`: inisialisasi dua counter dan hitung per lead. Setelah baris `for (const k of TAB_KEYS) counts[k] = 0;` tambahkan:
```js
  counts.fu_overdue = 0;
  counts.fu_pending = 0;
```
Di dalam loop, setelah blok yang merakit `item` dan menjalankan `for (const k of tabsForItem(item, now)) counts[k] += 1;`, tambahkan (pastikan `item` punya `first_inbound_at` & `last_outbound_at`):
```js
    item.last_outbound_at = c.last_outbound_at || null;
    const fu = followupState(item, now);
    if (fu.status === 'overdue') counts.fu_overdue += 1;
    else if (fu.status === 'fresh' || fu.status === 'pending') counts.fu_pending += 1;
```
(`item.first_inbound_at` sudah dirakit dari `s.first_inbound_at` di kode K3.)

- [ ] **Step 7: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest lotusKanban lotusFollowup -i`
Expected: PASS semua (termasuk test FU baru + regresi K2/K3).

- [ ] **Step 8: Verifikasi query nyata (last_outbound_at terisi)**

Run:
```bash
cd backend && node -e "const lotus=require('./db/lotus');(async()=>{try{const r=await lotus.query(\"WITH recent AS (SELECT c.cust_number FROM contacts c WHERE GREATEST(c.last_message_at,c.last_inbound_at) >= now() - interval '14 days' LIMIT 5) SELECT r.cust_number, lo.received_at AS last_outbound_at FROM recent r LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1) lo ON true\");console.log(r.rows);}catch(e){console.error('ERR',e.message)}finally{await lotus.end()}})()"
```
Expected: baris dengan `last_outbound_at` timestamp (atau null bila belum pernah outbound).

- [ ] **Step 9: Commit**

```bash
git add backend/routes/lotusInbox.js backend/__tests__/lotusKanban.test.js
git commit -m "feat(lotus-fu): last_outbound_at + fu_overdue filter + fu counts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task B3: Frontend — tab `fu_overdue` + banner FU asli

**Files:**
- Modify: `frontend/src/components/lotus-inbox/TabStrip.jsx`
- Modify: `frontend/src/components/lotus-inbox/TodayTasksCard.jsx`

- [ ] **Step 1: TabStrip — tambah tab `fu_overdue`**

Di `frontend/src/components/lotus-inbox/TabStrip.jsx`, pada array `TABS`, tambahkan entri di akhir:
```jsx
  { key: 'fu_overdue',    label: 'FU Overdue',    icon: '🔔', tone: 'rose' },
```

- [ ] **Step 2: TodayTasksCard — banner FU overdue asli**

Ganti isi `frontend/src/components/lotus-inbox/TodayTasksCard.jsx` dengan versi yang memakai `counts.fu_overdue`/`counts.fu_pending` untuk banner, fallback ke urgent bila tak ada FU overdue:

```jsx
// frontend/src/components/lotus-inbox/TodayTasksCard.jsx
export default function TodayTasksCard({ counts = {}, onPick }) {
  const urgent = counts.urgent || 0;
  const baru = counts.customer_baru || 0;
  const tunggu = counts.tunggu_balas || 0;
  const fuOverdue = counts.fu_overdue || 0;
  const fuPending = counts.fu_pending || 0;

  return (
    <div className="space-y-3">
      <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">Tugas kamu hari ini</div>
        <div className="flex flex-wrap gap-2">
          <Chip n={urgent}  label="Urgent"        tone="rose"    onClick={() => onPick('urgent')} />
          <Chip n={baru}    label="Customer Baru" tone="emerald" onClick={() => onPick('customer_baru')} />
          <Chip n={tunggu}  label="Tunggu Balas"  tone="amber"   onClick={() => onPick('tunggu_balas')} />
        </div>
      </div>

      {fuOverdue > 0 ? (
        <button onClick={() => onPick('fu_overdue')}
          className="w-full text-left bg-rose-600 text-white rounded-xl px-4 py-3 flex items-center justify-between">
          <span>
            <span className="font-semibold">{fuOverdue} FU overdue — kerjakan sekarang!</span>
            <span className="block text-xs text-rose-100 mt-0.5">{fuPending} FU pending (H+1/H+3/H+5)</span>
          </span>
          <span className="text-sm bg-white/20 px-3 py-1 rounded-lg whitespace-nowrap">Buka Tugas →</span>
        </button>
      ) : urgent > 0 ? (
        <button onClick={() => onPick('urgent')}
          className="w-full text-left bg-rose-600 text-white rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="font-semibold">{urgent} lead belum direspons — balas sekarang!</span>
          <span className="text-sm bg-white/20 px-3 py-1 rounded-lg">Buka →</span>
        </button>
      ) : null}
    </div>
  );
}

const TONES = {
  rose: 'border-rose-200 text-rose-700',
  emerald: 'border-emerald-200 text-emerald-700',
  amber: 'border-amber-200 text-amber-700',
};
function Chip({ n, label, tone, onClick }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-white ${TONES[tone] || ''}`}>
      <span className="text-base font-bold">{n || 0}</span>
      <span className="text-xs">{label}</span>
    </button>
  );
}
```

- [ ] **Step 3: Build verifikasi**

Run: `cd frontend && npm run build`
Expected: build sukses, `/lotus-inbox` ter-compile tanpa error.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/lotus-inbox/TabStrip.jsx frontend/src/components/lotus-inbox/TodayTasksCard.jsx
git commit -m "feat(lotus-fu): FU overdue tab + real FU banner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task B4: Verifikasi end-to-end & deploy

**Files:** none (operasional)

- [ ] **Step 1: Seluruh test backend kanban/fu**

Run: `cd backend && npx jest lotusTabs lotusKanban lotusFollowup -i`
Expected: semua hijau.

- [ ] **Step 2: Restart backend + frontend**

Run: `pm2 restart crm-pilot-backend && pm2 restart crm-pilot-frontend`
Expected: keduanya online; backend port 3009 boot bersih, frontend `Ready`.

- [ ] **Step 3: Smoke test (sesi admin via browser)**

Buka `https://salesai.prestisa.net/lotus-inbox`.
Expected: banner "{n} FU overdue — kerjakan sekarang!" muncul bila ada; klik "Buka Tugas" → list ke lead FU-overdue; tab "🔔 FU Overdue" memfilter sama; badge hitungan konsisten.

---

## Self-Review (sudah dijalankan penulis plan)

- **Cakupan spec:** cadence H+1/H+3/H+5 + status fresh/overdue/pending/done/expired → `followupState` (B1) ✓. last_outbound_at disediakan (B2 Step 4/6) ✓. filter `fu_overdue` (B2 Step 5) ✓. counts fu_overdue/fu_pending (B2 Step 6) ✓. banner FU asli + tab (B3) ✓. anchor=first_inbound_at, done=last_outbound_at≥due, scope active (lewat filter status active yang sudah ada) ✓.
- **Placeholder:** Step verifikasi data (B2 Step 8) langkah nyata.
- **Konsistensi tipe:** `followupState` membaca `first_inbound_at` + `last_outbound_at`; keduanya disediakan item `/contacts` (B2 Step 4) dan dirakit di loop `/tab-counts` (B2 Step 6). Status string ('overdue'/'fresh'/'pending'/'done'/'expired') dipakai konsisten di filter, counts, dan spec. Tab key `fu_overdue` konsisten antara route filter, `/tab-counts`, TabStrip TABS, dan `onPick` banner.
- **Tanpa migrasi/cron:** computed-only, sesuai keputusan.
