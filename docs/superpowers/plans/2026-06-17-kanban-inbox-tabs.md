# Kanban Inbox — 7 Smart Tabs (Sub-proyek A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tambah 7 tab smart-filter + kartu "Tugas hari ini" + banner ke `/lotus-inbox`, di-scope per user, tanpa perubahan skema DB.

**Architecture:** Logika tab diisolasi ke modul murni `services/lotusTabs.js` (unit-tested). Endpoint `/contacts` diperluas (ekspos field state + param `?tab=` + scoping), plus endpoint baru `/tab-counts`. Frontend menambah `TabStrip` + `TodayTasksCard` ke halaman lotus-inbox.

**Tech Stack:** Node/Express, PostgreSQL (dua DB: `db/lotus` + `db/postgres`), Jest + supertest, Next.js + Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-17-kanban-inbox-tabs-design.md`

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `backend/services/lotusTabs.js` (create) | Modul murni: `tabsForItem`, `THRESHOLDS`, `CLOSING_INTENTS`, helper WIB/inbound |
| `backend/__tests__/lotusTabs.test.js` (create) | Unit test modul murni |
| `backend/routes/lotusInbox.js` (modify) | Ekspos field state, param `?tab=`, scoping; endpoint `GET /tab-counts` |
| `backend/__tests__/lotusKanban.test.js` (create) | Test `?tab=` + `/tab-counts` (supertest + mock dua DB) |
| `frontend/src/components/lotus-inbox/TabStrip.jsx` (create) | 7 tab + badge angka |
| `frontend/src/components/lotus-inbox/TodayTasksCard.jsx` (create) | Kartu "Tugas hari ini" + banner |
| `frontend/src/pages/lotus-inbox/index.js` (modify) | Wire tab state, fetch tab-counts, scope toggle, render |

---

## Task K1: Modul murni `lotusTabs.js` (TDD)

**Files:**
- Create: `backend/services/lotusTabs.js`
- Test: `backend/__tests__/lotusTabs.test.js`

- [ ] **Step 1: Tulis test yang gagal**

```js
// backend/__tests__/lotusTabs.test.js
const { tabsForItem, THRESHOLDS, CLOSING_INTENTS } = require('../services/lotusTabs');

// now = 2026-06-17T02:00:00Z = 09:00 WIB (17 Juni). Awal hari WIB = 2026-06-16T17:00:00Z.
const NOW = new Date('2026-06-17T02:00:00Z');
const minAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

function item(over = {}) {
  return {
    status: 'active',
    last_message_from: 'inbound',
    last_message_at: minAgo(40),
    first_inbound_at: minAgo(50),
    lead_temperature: 'warm',
    lead_score: 10,
    last_intent: 'tanya_harga',
    root_cause_tag: null,
    snoozed_until: null,
    ...over,
  };
}

describe('urgent', () => {
  test('customer nunggu > 30 mnt → urgent', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(40) }), NOW)).toContain('urgent');
  });
  test('nunggu < 30 mnt → bukan urgent', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(10) }), NOW)).not.toContain('urgent');
  });
  test('snoozed → bukan urgent', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(40), snoozed_until: new Date(NOW.getTime()+3600000).toISOString() }), NOW)).not.toContain('urgent');
  });
  test('last msg dari sales → bukan urgent', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(40) }), NOW)).not.toContain('urgent');
  });
});

describe('hot_asap', () => {
  test("lead_temperature 'hot' → hot_asap", () => {
    expect(tabsForItem(item({ lead_temperature: 'HOT' }), NOW)).toContain('hot_asap');
  });
  test('warm → bukan hot_asap', () => {
    expect(tabsForItem(item({ lead_temperature: 'warm' }), NOW)).not.toContain('hot_asap');
  });
});

describe('customer_baru (WIB)', () => {
  test('first_inbound hari ini WIB → customer_baru', () => {
    expect(tabsForItem(item({ first_inbound_at: '2026-06-17T01:00:00Z' }), NOW)).toContain('customer_baru'); // 08:00 WIB hari ini
  });
  test('first_inbound kemarin WIB → bukan customer_baru', () => {
    expect(tabsForItem(item({ first_inbound_at: '2026-06-16T16:00:00Z' }), NOW)).not.toContain('customer_baru'); // 23:00 WIB kemarin
  });
});

describe('tunggu_balas', () => {
  test('nunggu 40 mnt → tunggu_balas', () => {
    expect(tabsForItem(item({ last_message_at: minAgo(40) }), NOW)).toContain('tunggu_balas');
  });
  test('nunggu 60 jam (>48j) → urgent ya, tunggu_balas tidak', () => {
    const t = tabsForItem(item({ last_message_at: minAgo(60*60) }), NOW);
    expect(t).toContain('urgent');
    expect(t).not.toContain('tunggu_balas');
  });
});

describe('mau_closing', () => {
  test('lead_score >= 60 → mau_closing', () => {
    expect(tabsForItem(item({ lead_score: 75 }), NOW)).toContain('mau_closing');
  });
  test('last_intent closing → mau_closing', () => {
    expect(tabsForItem(item({ last_intent: 'payment' }), NOW)).toContain('mau_closing');
  });
  test("root_cause_tag 'sudah_closing' → mau_closing", () => {
    expect(tabsForItem(item({ root_cause_tag: 'sudah_closing' }), NOW)).toContain('mau_closing');
  });
  test('skor rendah & intent biasa → bukan mau_closing', () => {
    expect(tabsForItem(item({ lead_score: 10, last_intent: 'tanya_harga' }), NOW)).not.toContain('mau_closing');
  });
});

describe('tunggu_cust', () => {
  test('sales balas, customer diam 3 jam → tunggu_cust', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(180) }), NOW)).toContain('tunggu_cust');
  });
  test('diam > 24 jam → bukan tunggu_cust', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(25*60) }), NOW)).not.toContain('tunggu_cust');
  });
  test('diam < 1 jam → bukan tunggu_cust', () => {
    expect(tabsForItem(item({ last_message_from: 'outbound', last_message_at: minAgo(30) }), NOW)).not.toContain('tunggu_cust');
  });
});

test('THRESHOLDS & CLOSING_INTENTS terdefinisi', () => {
  expect(THRESHOLDS.URGENT_MIN).toBe(30);
  expect(THRESHOLDS.TUNGGU_BALAS_MAX_MIN).toBe(48 * 60);
  expect(CLOSING_INTENTS.has('payment')).toBe(true);
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest lotusTabs -i`
Expected: FAIL — `Cannot find module '../services/lotusTabs'`.

- [ ] **Step 3: Implementasi modul**

```js
// backend/services/lotusTabs.js
// Logika murni Kanban Inbox: tentukan tab mana saja yang dicocoki satu lead item.
// Tidak menyentuh DB. Dipanggil HANYA untuk lead status='active' (status difilter di route).

const THRESHOLDS = {
  URGENT_MIN: 30,             // customer nunggu > 30 mnt → urgent
  TUNGGU_BALAS_MAX_MIN: 48 * 60,
  TUNGGU_CUST_MIN_MIN: 60,    // customer diam >= 1 jam
  TUNGGU_CUST_MAX_MIN: 24 * 60,
  CLOSING_SCORE: 60,
};

const CLOSING_INTENTS = new Set(['order_intent', 'order', 'payment', 'closing', 'checkout']);

const WIB_OFFSET_MS = 7 * 3600 * 1000;

function asDate(v) { return v instanceof Date ? v : new Date(v); }
function isInbound(v) { return /^in/i.test(String(v || '')); }
function minutesSince(now, ts) { return (asDate(now).getTime() - asDate(ts).getTime()) / 60000; }

function startOfTodayWIB(now) {
  const wibMs = asDate(now).getTime() + WIB_OFFSET_MS;
  const d = new Date(wibMs);
  const midnightWibAsUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return new Date(midnightWibAsUtc - WIB_OFFSET_MS);
}

function tabsForItem(item, now) {
  const tabs = [];
  const inbound = isInbound(item.last_message_from);
  const waiting = item.last_message_at != null ? minutesSince(now, item.last_message_at) : null;
  const snoozed = item.snoozed_until && asDate(item.snoozed_until) > asDate(now);

  if (inbound && waiting != null && waiting > THRESHOLDS.URGENT_MIN && !snoozed) tabs.push('urgent');

  if (/hot/i.test(String(item.lead_temperature || ''))) tabs.push('hot_asap');

  if (item.first_inbound_at && asDate(item.first_inbound_at) >= startOfTodayWIB(now)) tabs.push('customer_baru');

  if (inbound && waiting != null && waiting >= THRESHOLDS.URGENT_MIN
      && waiting <= THRESHOLDS.TUNGGU_BALAS_MAX_MIN && !snoozed) tabs.push('tunggu_balas');

  const score = Number(item.lead_score);
  if ((Number.isFinite(score) && score >= THRESHOLDS.CLOSING_SCORE)
      || CLOSING_INTENTS.has(String(item.last_intent || '').toLowerCase())
      || item.root_cause_tag === 'sudah_closing') tabs.push('mau_closing');

  if (!inbound && waiting != null && waiting >= THRESHOLDS.TUNGGU_CUST_MIN_MIN
      && waiting <= THRESHOLDS.TUNGGU_CUST_MAX_MIN && !snoozed) tabs.push('tunggu_cust');

  return tabs;
}

module.exports = { tabsForItem, startOfTodayWIB, isInbound, THRESHOLDS, CLOSING_INTENTS };
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest lotusTabs -i`
Expected: PASS semua.

- [ ] **Step 5: Commit**

```bash
git add backend/services/lotusTabs.js backend/__tests__/lotusTabs.test.js
git commit -m "feat(kanban): pure lotusTabs module with tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task K2: Perluas `GET /contacts` — ekspos field, `?tab=`, scoping

**Files:**
- Modify: `backend/routes/lotusInbox.js` (handler `router.get('/contacts'...)`, baris ~57–169)
- Test: `backend/__tests__/lotusKanban.test.js`

Konteks handler saat ini: fetch `contacts` (lotus DB, lateral join messages utk preview segar) → `getStateMap(lotusIds)` (vonage DB) → `.map(...)` jadi item → `.filter(...)` post-filter (status/queue). Item shape sekarang TIDAK mengekspos `first_inbound_at/first_response_at/lead_score/last_intent/handover_count/root_cause_tag`. `req.staff` punya `{ staff_id, role }`.

- [ ] **Step 1: Tulis test yang gagal**

```js
// backend/__tests__/lotusKanban.test.js
jest.mock('../db/lotus');
jest.mock('../db/postgres');
jest.mock('../db/mysql', () => ({ query: jest.fn() }));
const lotus = require('../db/lotus');
const pg = require('../db/postgres');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/lotus-inbox', require('../routes/lotusInbox'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin', username: 'boss' };
const SALES = { staff_id: 7, role: 'operator', username: 'rina' };

afterEach(() => jest.clearAllMocks());

// helper: stub satu contact row (lotus) + satu state row (vonage)
function stubData(contactRows, stateRows) {
  lotus.query.mockResolvedValue({ rows: contactRows });
  pg.query.mockResolvedValue({ rows: stateRows });
}
const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

describe('GET /contacts ?tab=urgent', () => {
  test('hanya lead yang cocok tab urgent yang lolos', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40), last_inbound_at: minAgo(40) },
        { lotus_id: 'B', cust_number: '2', cust_name: 'Budi', last_message_from: 'inbound', last_message_at: minAgo(5),  last_inbound_at: minAgo(5) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7 },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=urgent');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('item shape mengekspos field state baru', async () => {
    stubData(
      [{ lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40) }],
      [{ lotus_id: 'A', status: 'active', assigned_staff_id: 7, lead_score: 55, last_intent: 'tanya_harga', root_cause_tag: 'window_shopping', first_inbound_at: minAgo(120), handover_count: 1 }]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=all');
    const it = res.body.items[0];
    expect(it).toHaveProperty('lead_score', 55);
    expect(it).toHaveProperty('last_intent', 'tanya_harga');
    expect(it).toHaveProperty('root_cause_tag', 'window_shopping');
    expect(it).toHaveProperty('first_inbound_at');
    expect(it).toHaveProperty('handover_count', 1);
  });
});

describe('scoping by role', () => {
  test('sales (non-admin) hanya lihat lead assigned ke dirinya', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'C', cust_number: '3', cust_name: 'Cici', last_message_from: 'inbound', last_message_at: minAgo(40) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },   // punya SALES
        { lotus_id: 'C', status: 'active', assigned_staff_id: 99 },  // punya orang lain
      ]
    );
    const res = await request(appWith(SALES)).get('/api/lotus-inbox/contacts?tab=all');
    expect(res.body.items.map((i) => i.lotus_id)).toEqual(['A']);
  });

  test('admin lihat semua', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'C', cust_number: '3', cust_name: 'Cici', last_message_from: 'inbound', last_message_at: minAgo(40) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'C', status: 'active', assigned_staff_id: 99 },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/contacts?tab=all');
    expect(res.body.items.map((i) => i.lotus_id).sort()).toEqual(['A', 'C']);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest lotusKanban -i`
Expected: FAIL (field belum diekspos / scoping & tab belum ada).

- [ ] **Step 3: Implementasi — tambah require modul (atas file)**

Di `backend/routes/lotusInbox.js`, setelah baris-baris `require` yang ada (cari `require('../db/lotus')`), tambahkan:

```js
const { tabsForItem } = require('../services/lotusTabs');
```

- [ ] **Step 4: Implementasi — ekspos field state baru**

Di dalam `.map((c) => { const s = stateMap.get(...) ... return { ... } })`, di blok `// CRM state overlay:`, tambahkan field berikut setelah `lead_temperature: s.lead_temperature || null,`:

```js
      lead_temperature: s.lead_temperature || null,
      lead_score: s.lead_score ?? null,
      last_intent: s.last_intent || null,
      root_cause_tag: s.root_cause_tag || null,
      first_inbound_at: s.first_inbound_at || null,
      first_response_at: s.first_response_at || null,
      handover_count: s.handover_count ?? 0,
```

- [ ] **Step 5: Implementasi — scoping + tab di blok `.filter(...)`**

Ganti blok `.filter((it) => { ... })` menjadi (tambah scope by role + tab match; status di-default 'active' saat mode tab):

```js
  }).filter((it) => {
    const isAdmin = req.staff?.role === 'admin';
    const scope = req.query.scope; // 'mine' | 'team' (admin saja); non-admin selalu 'mine'
    const tab = req.query.tab;
    const effStatus = req.query.status || (tab ? 'active' : null);

    if (effStatus && it.status !== effStatus) return false;

    // Scoping per-user: non-admin hanya lead miliknya; admin default semua (toggle 'mine').
    if (!isAdmin || scope === 'mine') {
      if (it.assigned_staff_id !== req.staff.staff_id) return false;
    }
    // Filter queue lama tetap didukung
    if (queue === 'mine'        && it.assigned_staff_id !== req.staff.staff_id) return false;
    if (queue === 'unassigned'  && it.assigned_staff_id != null) return false;

    // Tab match (all = semua active dalam scope)
    if (tab && tab !== 'all' && !tabsForItem(it, new Date()).includes(tab)) return false;
    return true;
  });
```

- [ ] **Step 6: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest lotusKanban -i`
Expected: PASS semua.

- [ ] **Step 7: Verifikasi regresi suite lotus tidak rusak**

Run: `cd backend && npx jest lotus -i`
Expected: suite terkait lotus (jika ada) tetap hijau; minimal lotusTabs + lotusKanban hijau.

- [ ] **Step 8: Commit**

```bash
git add backend/routes/lotusInbox.js backend/__tests__/lotusKanban.test.js
git commit -m "feat(kanban): expose state fields + ?tab filter + role scoping in /contacts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task K3: Endpoint `GET /api/lotus-inbox/tab-counts`

Hitung jumlah lead per tab dalam scope user (untuk badge + kartu tugas + banner). Memindai lead `active` dengan aktivitas 14 hari terakhir (cap 1000) lalu hitung via `tabsForItem`.

**Files:**
- Modify: `backend/routes/lotusInbox.js` (tambah handler baru setelah handler `/contacts`)
- Modify: `backend/__tests__/lotusKanban.test.js`

- [ ] **Step 1: Tambah test yang gagal**

```js
// tambahkan di backend/__tests__/lotusKanban.test.js
describe('GET /tab-counts', () => {
  test('mengembalikan hitungan per tab dalam scope', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'inbound', last_message_at: minAgo(40) },   // urgent + tunggu_balas
        { lotus_id: 'B', cust_number: '2', last_message_from: 'outbound', last_message_at: minAgo(180) },  // tunggu_cust
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7, lead_temperature: 'hot' },                // + hot_asap
        { lotus_id: 'B', status: 'active', assigned_staff_id: 7 },
      ]
    );
    const res = await request(appWith(ADMIN)).get('/api/lotus-inbox/tab-counts');
    expect(res.status).toBe(200);
    expect(res.body.counts.all).toBe(2);
    expect(res.body.counts.urgent).toBe(1);
    expect(res.body.counts.tunggu_balas).toBe(1);
    expect(res.body.counts.tunggu_cust).toBe(1);
    expect(res.body.counts.hot_asap).toBe(1);
  });

  test('non-admin hanya menghitung lead miliknya', async () => {
    stubData(
      [
        { lotus_id: 'A', cust_number: '1', last_message_from: 'inbound', last_message_at: minAgo(40) },
        { lotus_id: 'C', cust_number: '3', last_message_from: 'inbound', last_message_at: minAgo(40) },
      ],
      [
        { lotus_id: 'A', status: 'active', assigned_staff_id: 7 },
        { lotus_id: 'C', status: 'active', assigned_staff_id: 99 },
      ]
    );
    const res = await request(appWith(SALES)).get('/api/lotus-inbox/tab-counts');
    expect(res.body.counts.all).toBe(1);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest lotusKanban -i -t "tab-counts"`
Expected: FAIL (404 / handler belum ada).

- [ ] **Step 3: Implementasi handler**

Tambahkan SETELAH handler `router.get('/contacts'...)` di `backend/routes/lotusInbox.js`:

```js
// ── tab-counts: jumlah lead per tab Kanban dalam scope user ───────────────────
const TAB_KEYS = ['urgent', 'hot_asap', 'customer_baru', 'tunggu_balas', 'mau_closing', 'tunggu_cust'];
router.get('/tab-counts', async (req, res) => {
  // Pindai lead aktif 14 hari terakhir (cap 1000) lalu hitung per tab.
  const { rows: contacts } = await lotus.query(
    `SELECT c.lotus_id, c.cust_number, c.last_message_from, c.last_message_at, c.last_inbound_at
     FROM contacts c
     WHERE GREATEST(c.last_message_at, c.last_inbound_at) >= now() - interval '14 days'
     ORDER BY GREATEST(c.last_message_at, c.last_inbound_at) DESC NULLS LAST
     LIMIT 1000`
  );
  const stateMap = await getStateMap(contacts.map((c) => c.lotus_id));

  const isAdmin = req.staff?.role === 'admin';
  const scope = req.query.scope;
  const now = new Date();

  const counts = { all: 0 };
  for (const k of TAB_KEYS) counts[k] = 0;

  for (const c of contacts) {
    const s = stateMap.get(c.lotus_id) || {};
    if ((s.status || 'active') !== 'active') continue;
    if (!isAdmin || scope === 'mine') {
      if ((s.assigned_staff_id ?? null) !== req.staff.staff_id) continue;
    }
    counts.all += 1;
    const item = {
      last_message_from: c.last_message_from,
      last_message_at: c.last_message_at,
      first_inbound_at: s.first_inbound_at || null,
      lead_temperature: s.lead_temperature || null,
      lead_score: s.lead_score ?? null,
      last_intent: s.last_intent || null,
      root_cause_tag: s.root_cause_tag || null,
      snoozed_until: s.snoozed_until || null,
    };
    for (const k of tabsForItem(item, now)) counts[k] += 1;
  }

  res.json({ success: true, counts });
});
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest lotusKanban -i`
Expected: PASS semua (contacts + tab-counts).

- [ ] **Step 5: Verifikasi query nyata `/tab-counts` ke DB (penyesuaian skema + tune ambang)**

Run:
```bash
cd backend && node -e "const lotus=require('./db/lotus');const pg=require('./db/postgres');(async()=>{try{const c=await lotus.query(\"SELECT lotus_id,last_message_from,last_message_at FROM contacts WHERE GREATEST(last_message_at,last_inbound_at) >= now() - interval '14 days' ORDER BY GREATEST(last_message_at,last_inbound_at) DESC LIMIT 5\");console.log('contacts ok:',c.rows.length, c.rows[0]||'(none)');const v=await pg.query(\"SELECT lead_score,last_intent FROM crm_lotus_state WHERE last_intent IS NOT NULL LIMIT 5\");console.log('sample intents/scores:', v.rows);}catch(e){console.error('MISMATCH:',e.message)}finally{await lotus.end();await pg.end()}})()"
```
Expected: `contacts ok: N ...` dan sampel `last_intent`/`lead_score`. **Jika nilai `last_intent` nyata berbeda dari `CLOSING_INTENTS`** (mis. ada `order_intent` vs `ORDER_INTENT` vs istilah lain) atau `lead_score` bukan skala 0–100, sesuaikan `CLOSING_INTENTS`/`CLOSING_SCORE` di `services/lotusTabs.js` lalu jalankan ulang `npx jest lotusTabs -i`. Catat penyesuaian di pesan commit.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/lotusInbox.js backend/__tests__/lotusKanban.test.js
git commit -m "feat(kanban): GET /tab-counts endpoint (per-tab counts, scoped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task K4: Komponen `TabStrip`

**Files:**
- Create: `frontend/src/components/lotus-inbox/TabStrip.jsx`

API: `<TabStrip tab={active} counts={countsObj} onChange={(key)=>...} />`. `counts` = objek dari `/tab-counts` (`{all, urgent, ...}`).

- [ ] **Step 1: Implementasi**

```jsx
// frontend/src/components/lotus-inbox/TabStrip.jsx
const TABS = [
  { key: 'all',           label: 'All',           icon: '',   tone: 'slate' },
  { key: 'urgent',        label: 'Urgent',        icon: '🚨', tone: 'rose' },
  { key: 'hot_asap',      label: 'Hot ASAP',      icon: '🔥', tone: 'orange' },
  { key: 'customer_baru', label: 'Customer Baru', icon: '🆕', tone: 'emerald' },
  { key: 'tunggu_balas',  label: 'Tunggu Balas',  icon: '⏰', tone: 'amber' },
  { key: 'mau_closing',   label: 'Mau Closing',   icon: '✅', tone: 'green' },
  { key: 'tunggu_cust',   label: 'Tunggu Cust',   icon: '🔁', tone: 'sky' },
];

export default function TabStrip({ tab, counts = {}, onChange }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1">
      {TABS.map((t) => {
        const active = (tab || 'all') === t.key;
        const n = counts[t.key];
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs whitespace-nowrap border transition
              ${active ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {t.icon && <span>{t.icon}</span>}
            <span className="font-medium">{t.label}</span>
            {typeof n === 'number' && (
              <span className={`ml-0.5 px-1.5 rounded-full text-[11px] ${active ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export { TABS };
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/lotus-inbox/TabStrip.jsx
git commit -m "feat(kanban): TabStrip component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task K5: Komponen `TodayTasksCard`

**Files:**
- Create: `frontend/src/components/lotus-inbox/TodayTasksCard.jsx`

API: `<TodayTasksCard counts={countsObj} onPick={(tabKey)=>...} />`. Menampilkan kartu "Tugas kamu hari ini" (Urgent / Customer Baru / Tunggu Balas) + banner ringkas "X lead belum direspons" (pakai `counts.urgent`). Klik chip memilih tab terkait.

- [ ] **Step 1: Implementasi**

```jsx
// frontend/src/components/lotus-inbox/TodayTasksCard.jsx
export default function TodayTasksCard({ counts = {}, onPick }) {
  const urgent = counts.urgent || 0;
  const baru = counts.customer_baru || 0;
  const tunggu = counts.tunggu_balas || 0;

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

      {urgent > 0 && (
        <button onClick={() => onPick('urgent')}
          className="w-full text-left bg-rose-600 text-white rounded-xl px-4 py-3 flex items-center justify-between">
          <span className="font-semibold">{urgent} lead belum direspons — balas sekarang!</span>
          <span className="text-sm bg-white/20 px-3 py-1 rounded-lg">Buka →</span>
        </button>
      )}
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

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/lotus-inbox/TodayTasksCard.jsx
git commit -m "feat(kanban): TodayTasksCard component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task K6: Wire ke halaman `lotus-inbox/index.js` (integrasi)

Ini task INTEGRASI — implementer HARUS membaca `frontend/src/pages/lotus-inbox/index.js` dulu untuk mengikuti pola fetch/URLSearchParams yang ada, lalu menyisipkan tab strip + kartu tugas + scope toggle.

**Files:**
- Modify: `frontend/src/pages/lotus-inbox/index.js`

**Requirements (wajib, jangan tambah fitur lain):**
1. Import `TabStrip` dari `@/components/lotus-inbox/TabStrip` dan `TodayTasksCard` dari `@/components/lotus-inbox/TodayTasksCard`.
2. Tambah state `tab` (default `'all'`). Saat fetch daftar `/api/lotus-inbox/contacts`, sertakan `?tab=<tab>` (selain filter yang sudah ada). Ikuti persis pola URLSearchParams/SWR yang sudah dipakai halaman.
3. Fetch `GET /api/lotus-inbox/tab-counts` (sertakan `scope` bila admin pilih "Saya") — gunakan mekanisme fetch yang sama (SWR `refreshInterval: 60_000` bila halaman memakai SWR). Simpan hasil `counts`.
4. Render `<TodayTasksCard counts={counts} onPick={setTab} />` di atas, lalu `<TabStrip tab={tab} counts={counts} onChange={setTab} />` di atas list. `onPick`/`onChange` mengubah state `tab` (dan idealnya sinkron ke URL `?tab=` mengikuti pola param lain yang sudah ada).
5. Scope toggle "Tim / Saya" HANYA tampil bila user admin (cek role via endpoint `/api/auth/me` seperti halaman lain, mis. `supervisor/index.js`). Toggle mengubah `scope` param ('team'→kosong, 'mine'→'mine') yang dikirim ke `/contacts` dan `/tab-counts`.
6. JANGAN hapus filter status/queue/sales yang sudah ada — tab strip ditambahkan di atasnya.

- [ ] **Step 1: Baca file & integrasikan sesuai requirements di atas.**
- [ ] **Step 2: Build verifikasi**

Run: `cd frontend && npm run build`
Expected: build sukses, route `/lotus-inbox` ter-compile tanpa error.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/lotus-inbox/index.js
git commit -m "feat(kanban): wire tab strip + today tasks card into lotus-inbox page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task K7: Verifikasi end-to-end & deploy

**Files:** none (operasional)

- [ ] **Step 1: Jalankan seluruh test backend (regresi)**

Run: `cd backend && npx jest -i`
Expected: semua suite hijau (termasuk lotusTabs + lotusKanban).

- [ ] **Step 2: Restart backend & cek boot**

Run: `pm2 restart crm-pilot-backend && pm2 logs crm-pilot-backend --lines 20 --nostream`
Expected: boot bersih port 3009, tanpa error route/SQL.

- [ ] **Step 3: Smoke test endpoint (sesi admin via browser)**

Buka `https://salesai.prestisa.net/lotus-inbox`.
Expected: tab strip 7 tab dengan badge angka tampil; kartu "Tugas hari ini" terisi; klik tab memfilter list; banner muncul bila ada lead urgent; toggle Tim/Saya bekerja (admin).

- [ ] **Step 4: Smoke test scoping (opsional, sesi sales)**

Login sebagai user non-admin → hanya lead miliknya yang muncul di semua tab.

---

## Self-Review (sudah dijalankan penulis plan)

- **Cakupan spec:** 7 tab → `tabsForItem` (K1) + filter `?tab=` (K2) ✓. Field state diekspos (K2) ✓. Scoping by role (K2/K3) ✓. tab-counts utk badge/kartu/banner (K3) ✓. UI TabStrip (K4) + TodayTasksCard+banner (K5) + integrasi (K6) ✓. Banner sementara "belum direspons" pakai counts.urgent (sesuai keputusan; FU akurat = Sub-proyek B) ✓.
- **Placeholder:** Step verifikasi (K3 Step 5) adalah langkah tuning nyata terhadap data, bukan placeholder.
- **Konsistensi tipe:** field yang dibaca `tabsForItem` (`status,last_message_from,last_message_at,first_inbound_at,lead_temperature,lead_score,last_intent,root_cause_tag,snoozed_until`) cocok dengan yang diekspos item shape (K2) dan yang dirakit di tab-counts (K3). Tab keys (`urgent,hot_asap,customer_baru,tunggu_balas,mau_closing,tunggu_cust`) konsisten antara modul, endpoint, `TABS` (TabStrip), dan `onPick` (TodayTasksCard).
- **Tanpa migrasi:** A tidak menyentuh skema DB.
- **Catatan keterbatasan MVP:** filter `?tab=` pada list bekerja setelah paginasi (cap 200) — sama seperti post-filter queue/status yang sudah ada; untuk scope per-sales (umumnya < 200 lead) aman. tab-counts memindai cap 1000 lead 14 hari. Jika scope tim admin > batas ini, perlu paginasi server-side lintas-DB (di luar scope A).
