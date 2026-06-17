# Supervisor Control Panel (MVP) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bangun halaman lead-centric "Supervisor Control" yang men-scan lead aktif belum-closing, menghitung sinyal waktu (lama balas / belum dibalas / FU gap), me-ranking prioritas P1/P2/P3, menampilkan AI Diagnosis on-demand (reuse analyst-report Tier A), dan mencatat aksi supervisor (Chat/Assign/Ack/Resolve/Revisi).

**Architecture:** Logika sinyal & prioritas diisolasi ke modul murni `services/supervisorSignals.js` (unit-tested). Route baru `/api/supervisor-control` (admin-only) menyajikan queue + endpoint aksi. Frontend Next.js page `/supervisor-control` auto-refresh 60 detik, expand-row memanggil endpoint analyst-report lama untuk AI Diagnosis. Satu migrasi menambah tabel aksi + flag ack.

**Tech Stack:** Node/Express, PostgreSQL (`pg`), Jest + supertest, Next.js + SWR + Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-17-supervisor-control-panel-design.md`

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `backend/migrations/034_supervisor_control.sql` (create) | Tabel `crm_lead_supervisor_actions` + kolom `supervisor_ack_at`/`supervisor_ack_by` di `crm_lotus_state` |
| `backend/services/supervisorSignals.js` (create) | Modul murni: `deriveSignals`, `priorityTier`, `groupLabel`, konstanta threshold |
| `backend/__tests__/supervisorSignals.test.js` (create) | Unit test modul murni |
| `backend/routes/supervisorControl.js` (create) | Route admin: `GET /queue`, `POST /lead/:lotus_id/action` |
| `backend/__tests__/supervisorControl.test.js` (create) | Test route (supertest + mock pg) |
| `backend/index.js` (modify) | Daftar & mount route baru |
| `frontend/src/components/Layout.jsx` (modify) | Tambah nav item Supervisor Control |
| `frontend/src/components/supervisor-control/DiagnosisPanel.jsx` (create) | Panel AI Diagnosis on-demand (panggil analyst-report) |
| `frontend/src/components/supervisor-control/LeadRow.jsx` (create) | Baris lead + badge prioritas + tombol aksi + expand |
| `frontend/src/pages/supervisor-control/index.js` (create) | Halaman queue: fetch, filter strip, auto-refresh |

---

## Task 1: Migrasi DB — tabel aksi + flag ack

**Files:**
- Create: `backend/migrations/034_supervisor_control.sql`

- [ ] **Step 1: Tulis file migrasi**

```sql
-- 034_supervisor_control.sql
-- Supervisor Control Panel: catatan aksi supervisor + flag ack/resolve pada lead state.

CREATE TABLE IF NOT EXISTS crm_lead_supervisor_actions (
  id                   bigserial PRIMARY KEY,
  lotus_id             text NOT NULL,
  staff_id             int  NOT NULL,
  action               text NOT NULL,            -- ack | resolve | reassign | request_fu | revise_ai
  note                 text,
  corrected_root_cause text,                     -- diisi saat action='revise_ai'
  corrected_reason     text,                     -- diisi saat action='revise_ai'
  final_status         text,                     -- diisi saat action='revise_ai'
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_sup_actions_lotus
  ON crm_lead_supervisor_actions (lotus_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_sup_actions_revise
  ON crm_lead_supervisor_actions (action) WHERE action = 'revise_ai';

ALTER TABLE crm_lotus_state
  ADD COLUMN IF NOT EXISTS supervisor_ack_at timestamptz,
  ADD COLUMN IF NOT EXISTS supervisor_ack_by int;
```

- [ ] **Step 2: Jalankan migrasi**

Run: `cd backend && npm run migrate`
Expected: log menerapkan `034_supervisor_control.sql` tanpa error (migrasi idempoten — aman diulang).

- [ ] **Step 3: Verifikasi objek dibuat**

Run:
```bash
cd backend && node -e "const pg=require('./db/postgres');(async()=>{const a=await pg.query(\"select to_regclass('crm_lead_supervisor_actions') as t\");const b=await pg.query(\"select column_name from information_schema.columns where table_name='crm_lotus_state' and column_name in ('supervisor_ack_at','supervisor_ack_by') order by column_name\");console.log('table:',a.rows[0].t);console.log('cols:',b.rows.map(r=>r.column_name).join(','));await pg.end()})()"
```
Expected: `table: crm_lead_supervisor_actions` dan `cols: supervisor_ack_at,supervisor_ack_by`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/034_supervisor_control.sql
git commit -m "feat(supervisor-control): migration 034 — actions table + ack flags"
```

---

## Task 2: Modul murni sinyal & prioritas (TDD)

Modul ini menerima satu objek "lead row" yang sudah berisi field mentah dari query (timestamp string/Date, count, dsb) plus `now` (Date), lalu mengembalikan sinyal turunan + tier + group. Tanpa akses DB → mudah diuji.

**Files:**
- Create: `backend/services/supervisorSignals.js`
- Test: `backend/__tests__/supervisorSignals.test.js`

- [ ] **Step 1: Tulis test yang gagal**

```js
// backend/__tests__/supervisorSignals.test.js
const { deriveSignals, priorityTier, groupLabel, THRESHOLDS } = require('../services/supervisorSignals');

const NOW = new Date('2026-06-17T10:00:00Z');
function row(over = {}) {
  return {
    lotus_id: 'L1',
    last_message_from: 'in',                 // 'in' | 'out'
    last_message_at: '2026-06-17T09:40:00Z', // 20 menit lalu
    last_inbound_at: '2026-06-17T09:40:00Z',
    first_inbound_at: '2026-06-17T08:00:00Z',
    first_response_at: '2026-06-17T08:00:30Z',
    inbound_count: 3,
    fu_today: 0,
    lead_temperature: 'warm',
    status: 'active',
    root_cause_tag: null,
    funnel_stage_lost: null,
    asked_price: false,
    ...over,
  };
}

describe('deriveSignals', () => {
  test('last msg dari customer → awaiting_sales_reply_min terisi, customer null', () => {
    const s = deriveSignals(row(), NOW);
    expect(s.last_is_inbound).toBe(true);
    expect(s.awaiting_sales_reply_min).toBe(20);
    expect(s.awaiting_customer_reply_min).toBeNull();
  });

  test('last msg dari sales → awaiting_customer_reply_min terisi', () => {
    const s = deriveSignals(row({ last_message_from: 'out', last_message_at: '2026-06-17T08:30:00Z' }), NOW);
    expect(s.last_is_inbound).toBe(false);
    expect(s.awaiting_customer_reply_min).toBe(90);
    expect(s.awaiting_sales_reply_min).toBeNull();
  });

  test('belum pernah dibalas → never_responded true, lag null', () => {
    const s = deriveSignals(row({ first_response_at: null }), NOW);
    expect(s.never_responded).toBe(true);
    expect(s.first_response_lag_min).toBeNull();
  });

  test('first_response_lag_min dihitung dari first_inbound→first_response', () => {
    const s = deriveSignals(row(), NOW);
    expect(s.never_responded).toBe(false);
    expect(s.first_response_lag_min).toBeCloseTo(0.5, 3);
  });

  test('single_bubble true saat inbound_count === 1', () => {
    expect(deriveSignals(row({ inbound_count: 1 }), NOW).single_bubble).toBe(true);
    expect(deriveSignals(row({ inbound_count: 2 }), NOW).single_bubble).toBe(false);
  });
});

describe('priorityTier', () => {
  test('belum pernah dibalas → P1', () => {
    expect(priorityTier(deriveSignals(row({ first_response_at: null }), NOW))).toBe('P1');
  });
  test('customer nunggu > 10 menit → P1', () => {
    expect(priorityTier(deriveSignals(row({ last_message_at: '2026-06-17T09:45:00Z', last_inbound_at: '2026-06-17T09:45:00Z' }), NOW))).toBe('P1');
  });
  test('sudah tanya harga tapi belum lanjut → P1', () => {
    const s = deriveSignals(row({ last_message_from: 'in', asked_price: true, last_message_at: '2026-06-17T09:58:00Z', last_inbound_at: '2026-06-17T09:58:00Z' }), NOW);
    expect(priorityTier(s)).toBe('P1');
  });
  test('customer belum balas > 60 menit & belum ada FU → P2', () => {
    const s = deriveSignals(row({ last_message_from: 'out', last_message_at: '2026-06-17T08:30:00Z', fu_today: 0 }), NOW);
    expect(priorityTier(s)).toBe('P2');
  });
  test('lead hot belum closing & FU belum lengkap → P2', () => {
    const s = deriveSignals(row({ last_message_from: 'out', last_message_at: '2026-06-17T09:50:00Z', lead_temperature: 'hot', fu_today: 0 }), NOW);
    expect(priorityTier(s)).toBe('P2');
  });
  test('single bubble tanpa sinyal lain → P3', () => {
    const s = deriveSignals(row({ last_message_from: 'out', last_message_at: '2026-06-17T09:50:00Z', inbound_count: 1, lead_temperature: 'cold' }), NOW);
    expect(priorityTier(s)).toBe('P3');
  });
});

describe('groupLabel', () => {
  test('customer nunggu balasan → sales_response_risk', () => {
    expect(groupLabel(deriveSignals(row(), NOW))).toBe('sales_response_risk');
  });
  test('belum pernah dibalas → sales_response_risk', () => {
    expect(groupLabel(deriveSignals(row({ first_response_at: null }), NOW))).toBe('sales_response_risk');
  });
  test('punya root_cause_tag → lead_stuck', () => {
    const s = deriveSignals(row({ last_message_from: 'out', last_message_at: '2026-06-17T09:55:00Z', root_cause_tag: 'harga_terlalu_mahal' }), NOW);
    expect(groupLabel(s)).toBe('lead_stuck');
  });
  test('customer belum balas → follow_up_customer', () => {
    const s = deriveSignals(row({ last_message_from: 'out', last_message_at: '2026-06-17T08:30:00Z' }), NOW);
    expect(groupLabel(s)).toBe('follow_up_customer');
  });
});

test('THRESHOLDS punya nilai default 10 & 60', () => {
  expect(THRESHOLDS.SALES_REPLY_MIN).toBe(10);
  expect(THRESHOLDS.CUSTOMER_REPLY_MIN).toBe(60);
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest supervisorSignals -i`
Expected: FAIL — `Cannot find module '../services/supervisorSignals'`.

- [ ] **Step 3: Implementasi modul murni**

```js
// backend/services/supervisorSignals.js
// Logika murni untuk Supervisor Control Panel: turunkan sinyal waktu dari satu lead row,
// lalu tentukan tier prioritas (P1/P2/P3) dan grup. Tidak menyentuh DB.

const THRESHOLDS = {
  SALES_REPLY_MIN: 10,     // customer belum dibalas > 10 menit → kritis
  CUSTOMER_REPLY_MIN: 60,  // customer belum balas > 60 menit → high
};

function minutesBetween(later, earlier) {
  const a = later instanceof Date ? later : new Date(later);
  const b = earlier instanceof Date ? earlier : new Date(earlier);
  return (a.getTime() - b.getTime()) / 60000;
}

function deriveSignals(row, now) {
  const nowD = now instanceof Date ? now : new Date(now);
  const last_is_inbound = row.last_message_from === 'in';

  const awaiting_sales_reply_min = last_is_inbound && row.last_message_at
    ? minutesBetween(nowD, row.last_message_at) : null;
  const awaiting_customer_reply_min = !last_is_inbound && row.last_message_at
    ? minutesBetween(nowD, row.last_message_at) : null;

  const never_responded = !row.first_response_at;
  const first_response_lag_min = (row.first_inbound_at && row.first_response_at)
    ? minutesBetween(row.first_response_at, row.first_inbound_at) : null;

  const single_bubble = Number(row.inbound_count) === 1;

  return {
    lotus_id: row.lotus_id,
    last_is_inbound,
    awaiting_sales_reply_min,
    awaiting_customer_reply_min,
    never_responded,
    first_response_lag_min,
    single_bubble,
    fu_today: Number(row.fu_today) || 0,
    lead_temperature: row.lead_temperature || null,
    status: row.status || null,
    root_cause_tag: row.root_cause_tag || null,
    funnel_stage_lost: row.funnel_stage_lost || null,
    asked_price: !!row.asked_price,
  };
}

function priorityTier(s) {
  // P1 Critical
  if (s.never_responded) return 'P1';
  if (s.awaiting_sales_reply_min != null && s.awaiting_sales_reply_min > THRESHOLDS.SALES_REPLY_MIN) return 'P1';
  if (s.asked_price && s.last_is_inbound) return 'P1';

  // P2 High
  if (s.awaiting_customer_reply_min != null && s.awaiting_customer_reply_min > THRESHOLDS.CUSTOMER_REPLY_MIN && s.fu_today === 0) return 'P2';
  if (s.lead_temperature === 'hot' && s.status === 'active' && s.fu_today === 0) return 'P2';

  // P3 Monitor (sisanya yang masih perlu dipantau)
  return 'P3';
}

function groupLabel(s) {
  if (s.never_responded || s.last_is_inbound) return 'sales_response_risk';
  if (s.root_cause_tag || s.funnel_stage_lost) return 'lead_stuck';
  return 'follow_up_customer';
}

module.exports = { deriveSignals, priorityTier, groupLabel, THRESHOLDS };
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest supervisorSignals -i`
Expected: PASS, semua test hijau.

- [ ] **Step 5: Commit**

```bash
git add backend/services/supervisorSignals.js backend/__tests__/supervisorSignals.test.js
git commit -m "feat(supervisor-control): pure signal + priority module with tests"
```

---

## Task 3: Route `GET /api/supervisor-control/queue`

Endpoint scan lead aktif belum-closing (aktivitas ≤7 hari), keluarkan field mentah, lalu petakan via modul Task 2. Catatan kolom: nilai sinyal waktu diambil dari `contacts` (`last_message_from` `'in'/'out'`, `last_message_at`, `last_inbound_at`) yang sudah dipakai endpoint lotus lama; `inbound_count` dari agregasi `messages` per `cust_number`; `first_inbound_at`/`first_response_at`/`root_cause_tag`/`funnel_stage_lost`/`lead_temperature`/`status` dari `crm_lotus_state`.

**Files:**
- Create: `backend/routes/supervisorControl.js`
- Test: `backend/__tests__/supervisorControl.test.js`

- [ ] **Step 1: Tulis test yang gagal (queue)**

```js
// backend/__tests__/supervisorControl.test.js
jest.mock('../db/postgres');
const pg = require('../db/postgres');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express();
  app.use(express.json());
  // suntik req.staff sebelum router (gantikan requireStaff di test)
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/supervisor-control', require('../routes/supervisorControl'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin', username: 'boss' };

afterEach(() => jest.clearAllMocks());

describe('GET /queue', () => {
  test('403 untuk non-admin', async () => {
    const app = appWith({ staff_id: 2, role: 'operator' });
    const res = await request(app).get('/api/supervisor-control/queue');
    expect(res.status).toBe(403);
  });

  test('mengembalikan lead ter-rank dengan tier & group', async () => {
    pg.query.mockResolvedValueOnce({ rows: [
      { lotus_id: 'L1', cust_name: 'Melati', pic_name: 'Rina', business_number: '628',
        last_message: 'harganya berapa kak?', last_message_from: 'in',
        last_message_at: new Date(Date.now() - 18*60000).toISOString(),
        last_inbound_at: new Date(Date.now() - 18*60000).toISOString(),
        first_inbound_at: new Date(Date.now() - 60*60000).toISOString(),
        first_response_at: new Date(Date.now() - 59*60000).toISOString(),
        inbound_count: 3, fu_today: 0, lead_temperature: 'warm', status: 'active',
        root_cause_tag: null, funnel_stage_lost: null, lead_product: 'papan' },
    ] });
    const app = appWith(ADMIN);
    const res = await request(app).get('/api/supervisor-control/queue');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ lotus_id: 'L1', tier: 'P1', group: 'sales_response_risk' });
    expect(res.body.items[0].awaiting_sales_reply_min).toBeGreaterThan(10);
  });

  test('filter group lewat query param', async () => {
    pg.query.mockResolvedValueOnce({ rows: [
      { lotus_id: 'A', last_message_from: 'in', last_message_at: new Date(Date.now()-5*60000).toISOString(), last_inbound_at: new Date(Date.now()-5*60000).toISOString(), first_inbound_at: new Date(Date.now()-30*60000).toISOString(), first_response_at: new Date(Date.now()-29*60000).toISOString(), inbound_count: 2, fu_today: 0, status: 'active' },
      { lotus_id: 'B', last_message_from: 'out', last_message_at: new Date(Date.now()-120*60000).toISOString(), last_inbound_at: new Date(Date.now()-130*60000).toISOString(), first_inbound_at: new Date(Date.now()-200*60000).toISOString(), first_response_at: new Date(Date.now()-199*60000).toISOString(), inbound_count: 4, fu_today: 0, status: 'active' },
    ] });
    const app = appWith(ADMIN);
    const res = await request(app).get('/api/supervisor-control/queue?group=follow_up_customer');
    expect(res.body.items.map(i => i.lotus_id)).toEqual(['B']);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest supervisorControl -i`
Expected: FAIL — `Cannot find module '../routes/supervisorControl'`.

- [ ] **Step 3: Implementasi route (queue dulu)**

> Catatan eksekutor: query di bawah memakai alias kolom yang stabil. Sebelum menandai task selesai, jalankan Step 4b (verifikasi query asli di DB) dan sesuaikan nama kolom `messages`/`contacts` bila skema berbeda — alias keluaran (`last_message_from`, `inbound_count`, dst.) harus tetap sama agar modul Task 2 cocok.

```js
// backend/routes/supervisorControl.js
// Supervisor Control Panel (lead-centric). Admin-only.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const { deriveSignals, priorityTier, groupLabel } = require('../services/supervisorSignals');

const router = express.Router();
router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

const TIER_RANK = { P1: 0, P2: 1, P3: 2 };

// GET /queue?group=all|sales_response_risk|follow_up_customer|lead_stuck&sales=<name>
router.get('/queue', async (req, res, next) => {
  try {
    const { rows } = await pg.query(
      `WITH msg_cnt AS (
         SELECT cust_number, COUNT(*) FILTER (WHERE direction='inbound') AS inbound_count
         FROM messages
         WHERE received_at >= now() - interval '7 days'
         GROUP BY cust_number
       ),
       fu AS (
         SELECT s.lotus_id, COUNT(*) FILTER (
                  WHERE f.sent_at::date = current_date) AS fu_today
         FROM crm_lotus_state s
         LEFT JOIN crm_followups f ON f.conversation_id = s.customer_id
         GROUP BY s.lotus_id
       )
       SELECT c.lotus_id, c.cust_name, c.business_number, c.lead_product,
              c.last_message, c.last_message_from, c.last_message_at, c.last_inbound_at,
              s.assigned_staff_id, u.full_name AS pic_name,
              s.first_inbound_at, s.first_response_at,
              s.lead_temperature, s.status, s.root_cause_tag, s.funnel_stage_lost,
              s.supervisor_ack_at,
              COALESCE(mc.inbound_count, 0) AS inbound_count,
              COALESCE(fu.fu_today, 0)     AS fu_today
       FROM contacts c
       JOIN crm_lotus_state s ON s.lotus_id = c.lotus_id
       LEFT JOIN staff_users u ON u.id = s.assigned_staff_id
       LEFT JOIN msg_cnt mc ON mc.cust_number = c.cust_number
       LEFT JOIN fu        ON fu.lotus_id = c.lotus_id
       WHERE s.status = 'active'
         AND c.last_message_at >= now() - interval '7 days'
         AND (s.supervisor_ack_at IS NULL OR c.last_inbound_at > s.supervisor_ack_at)`
    );

    const now = new Date();
    const wantGroup = req.query.group && req.query.group !== 'all' ? req.query.group : null;
    const wantSales = req.query.sales || null;

    let items = rows.map((r) => {
      const sig = deriveSignals({
        ...r,
        asked_price: /harga|berapa|price/i.test(r.last_message || ''),
      }, now);
      return {
        lotus_id: r.lotus_id,
        cust_name: r.cust_name,
        pic_name: r.pic_name,
        lead_product: r.lead_product,
        last_message: r.last_message,
        last_message_at: r.last_message_at,
        status: r.status,
        root_cause_tag: r.root_cause_tag,
        tier: priorityTier(sig),
        group: groupLabel(sig),
        last_is_inbound: sig.last_is_inbound,
        awaiting_sales_reply_min: sig.awaiting_sales_reply_min,
        awaiting_customer_reply_min: sig.awaiting_customer_reply_min,
        never_responded: sig.never_responded,
        first_response_lag_min: sig.first_response_lag_min,
        single_bubble: sig.single_bubble,
        fu_today: sig.fu_today,
      };
    });

    if (wantGroup) items = items.filter((i) => i.group === wantGroup);
    if (wantSales) items = items.filter((i) => (i.pic_name || '') === wantSales);

    items.sort((a, b) => {
      if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
      const wa = a.awaiting_sales_reply_min ?? a.awaiting_customer_reply_min ?? 0;
      const wb = b.awaiting_sales_reply_min ?? b.awaiting_customer_reply_min ?? 0;
      return wb - wa; // yang menunggu paling lama di atas
    });

    res.json({ items, counts: {
      total: items.length,
      P1: items.filter((i) => i.tier === 'P1').length,
      P2: items.filter((i) => i.tier === 'P2').length,
      P3: items.filter((i) => i.tier === 'P3').length,
    } });
  } catch (e) { next(e); }
});

module.exports = router;
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest supervisorControl -i`
Expected: PASS (test queue & filter & 403 hijau).

- [ ] **Step 4b: Verifikasi query nyata di DB (penyesuaian skema)**

Run:
```bash
cd backend && node -e "const pg=require('./db/postgres');(async()=>{try{const r=await pg.query(\"WITH msg_cnt AS (SELECT cust_number, COUNT(*) FILTER (WHERE direction='inbound') AS inbound_count FROM messages WHERE received_at >= now() - interval '7 days' GROUP BY cust_number) SELECT c.lotus_id, c.last_message_from, COALESCE(mc.inbound_count,0) AS inbound_count, s.status FROM contacts c JOIN crm_lotus_state s ON s.lotus_id=c.lotus_id LEFT JOIN msg_cnt mc ON mc.cust_number=c.cust_number WHERE s.status='active' AND c.last_message_at >= now() - interval '7 days' LIMIT 3\");console.log('OK rows:',r.rows.length, r.rows[0]||'(none)')}catch(e){console.error('SCHEMA MISMATCH:',e.message)}finally{await pg.end()}})()"
```
Expected: `OK rows: N ...`. Jika `SCHEMA MISMATCH`, sesuaikan nama kolom/tabel pada query Step 3 (pertahankan alias keluaran), lalu ulangi Step 4.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/supervisorControl.js backend/__tests__/supervisorControl.test.js
git commit -m "feat(supervisor-control): GET /queue endpoint with ranking"
```

---

## Task 4: Route `POST /api/supervisor-control/lead/:lotus_id/action`

Catat aksi supervisor. Untuk `ack`/`resolve` juga set `supervisor_ack_at`/`supervisor_ack_by` di `crm_lotus_state` (sembunyikan dari queue sampai ada inbound baru). Untuk `revise_ai` simpan `corrected_root_cause`/`corrected_reason`/`final_status`.

**Files:**
- Modify: `backend/routes/supervisorControl.js`
- Modify: `backend/__tests__/supervisorControl.test.js`

- [ ] **Step 1: Tambah test yang gagal**

```js
// tambahkan di backend/__tests__/supervisorControl.test.js
describe('POST /lead/:id/action', () => {
  test('menolak action tak dikenal (400)', async () => {
    const app = appWith(ADMIN);
    const res = await request(app).post('/api/supervisor-control/lead/L1/action').send({ action: 'nope' });
    expect(res.status).toBe(400);
  });

  test('ack: insert log + update ack flag', async () => {
    pg.query
      .mockResolvedValueOnce({ rows: [{ id: 10 }] })   // INSERT action
      .mockResolvedValueOnce({ rowCount: 1 });          // UPDATE state
    const app = appWith(ADMIN);
    const res = await request(app).post('/api/supervisor-control/lead/L1/action')
      .send({ action: 'ack', note: 'analisa sesuai' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(2);
    const updateSql = pg.query.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE crm_lotus_state/i);
  });

  test('revise_ai: insert log saja (tanpa update ack)', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 11 }] });
    const app = appWith(ADMIN);
    const res = await request(app).post('/api/supervisor-control/lead/L1/action')
      .send({ action: 'revise_ai', corrected_root_cause: 'harga_terlalu_mahal', corrected_reason: 'budget customer kecil', final_status: 'lost', note: 'sales kirim harga terlalu cepat' });
    expect(res.status).toBe(200);
    expect(pg.query).toHaveBeenCalledTimes(1);
    const insertSql = pg.query.mock.calls[0][0];
    expect(insertSql).toMatch(/INSERT INTO crm_lead_supervisor_actions/i);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest supervisorControl -i -t "POST /lead"`
Expected: FAIL — route belum ada (404), assertion gagal.

- [ ] **Step 3: Implementasi handler action**

Tambahkan SEBELUM `module.exports = router;` di `backend/routes/supervisorControl.js`:

```js
const VALID_ACTIONS = new Set(['ack', 'resolve', 'reassign', 'request_fu', 'revise_ai']);

// POST /lead/:lotus_id/action
router.post('/lead/:lotus_id/action', async (req, res, next) => {
  try {
    const { lotus_id } = req.params;
    const { action, note, corrected_root_cause, corrected_reason, final_status } = req.body || {};
    if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: 'bad_action' });

    const ins = await pg.query(
      `INSERT INTO crm_lead_supervisor_actions
         (lotus_id, staff_id, action, note, corrected_root_cause, corrected_reason, final_status)
       VALUES ($1, $2, $3, $4::text, $5::text, $6::text, $7::text)
       RETURNING id`,
      [lotus_id, req.staff.staff_id, action, note || null,
       corrected_root_cause || null, corrected_reason || null, final_status || null]
    );

    if (action === 'ack' || action === 'resolve') {
      await pg.query(
        `UPDATE crm_lotus_state
           SET supervisor_ack_at = now(), supervisor_ack_by = $2
         WHERE lotus_id = $1`,
        [lotus_id, req.staff.staff_id]
      );
    }

    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest supervisorControl -i`
Expected: PASS semua (queue + action).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/supervisorControl.js backend/__tests__/supervisorControl.test.js
git commit -m "feat(supervisor-control): POST lead action (ack/resolve/revise_ai)"
```

---

## Task 5: Mount route di `index.js`

**Files:**
- Modify: `backend/index.js` (require list ~line 26; mount list ~line 71)

- [ ] **Step 1: Tambah require**

Setelah baris `const supervisorRoutes = require('./routes/supervisor');` tambahkan:

```js
const supervisorControlRoutes = require('./routes/supervisorControl');
```

- [ ] **Step 2: Tambah mount**

Setelah baris `app.use('/api/supervisor', supervisorRoutes);` tambahkan:

```js
app.use('/api/supervisor-control', supervisorControlRoutes);
```

- [ ] **Step 3: Verifikasi server boot + route terpasang**

Run: `cd backend && node -e "require('./routes/supervisorControl'); console.log('route module OK')"`
Expected: `route module OK` (tanpa error require/sintaks).

- [ ] **Step 4: Jalankan seluruh test backend (regresi)**

Run: `cd backend && npx jest -i`
Expected: semua suite hijau (termasuk dua suite baru).

- [ ] **Step 5: Commit**

```bash
git add backend/index.js
git commit -m "feat(supervisor-control): mount /api/supervisor-control route"
```

---

## Task 6: Nav menu

**Files:**
- Modify: `frontend/src/components/Layout.jsx` (array `navItems`, ~line 16)

- [ ] **Step 1: Tambah item nav setelah baris `/supervisor`**

Sisipkan tepat setelah entri `{ href: '/supervisor', ... }`:

```jsx
  { href: '/supervisor-control', label: 'Supervisor Control', icon: '👁‍🗨', adminOnly: true },
```

- [ ] **Step 2: Verifikasi build frontend tidak error sintaks**

Run: `cd frontend && npx next lint --file src/components/Layout.jsx || true`
Expected: tidak ada error parse pada file (peringatan lint lain boleh diabaikan).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Layout.jsx
git commit -m "feat(supervisor-control): add nav menu item"
```

---

## Task 7: Komponen `DiagnosisPanel`

Panel AI Diagnosis on-demand: saat di-expand, POST ke endpoint analyst-report lama (`/api/lotus-inbox/contacts/:lotus_id/analyst-report` body `{tier:'A'}`), tampilkan hasil + tombol aksi. Memanggil `onAction(action, payload)` milik parent untuk mencatat aksi.

**Files:**
- Create: `frontend/src/components/supervisor-control/DiagnosisPanel.jsx`

- [ ] **Step 1: Implementasi komponen**

```jsx
// frontend/src/components/supervisor-control/DiagnosisPanel.jsx
import { useState } from 'react';
import { api } from '@/lib/api';

const ROOT_CAUSES = [
  'harga_terlalu_mahal','barang_tidak_tersedia','respon_lambat','info_produk_kurang',
  'ekspektasi_design','area_pengiriman','timing_pengiriman','kompetitor',
  'ragu_kredibilitas','window_shopping','sudah_closing','bukan_lead','lainnya',
];

export default function DiagnosisPanel({ lotusId, onAction }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [revising, setRevising] = useState(false);
  const [rev, setRev] = useState({ corrected_root_cause: '', corrected_reason: '', final_status: '', note: '' });

  async function generate() {
    setLoading(true); setError(null);
    try {
      const data = await api(`/api/lotus-inbox/contacts/${lotusId}/analyst-report`, {
        method: 'POST', body: JSON.stringify({ tier: 'A' }),
      });
      setReport(data);
    } catch (e) { setError(e.message || 'Gagal generate'); }
    finally { setLoading(false); }
  }

  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 space-y-3 text-sm">
      {!report && !loading && (
        <button onClick={generate} className="px-3 py-1.5 rounded bg-sky-600 text-white text-xs font-medium">
          Generate AI Diagnosis
        </button>
      )}
      {loading && <div className="text-slate-500">Menganalisa percakapan…</div>}
      {error && <div className="text-rose-600">{error}</div>}

      {report && (
        <div className="space-y-2">
          <Field label="AI Diagnosis" value={report.customer_intent || report.analyst_summary_md} />
          <Field label="Root Issue" value={report.root_cause_tag || report.funnel_stage_lost} />
          <Field label="Status Lead" value={report.lead_status} />
          {report.evidence_quote && <Field label="Bukti" value={`"${report.evidence_quote}"`} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <ActBtn onClick={() => onAction('ack', { note: 'analisa sesuai' })} cls="bg-emerald-600">Ack — Analisa Sesuai</ActBtn>
        <ActBtn onClick={() => onAction('resolve', { note: 'sudah ditindaklanjuti' })} cls="bg-slate-700">Resolve</ActBtn>
        <ActBtn onClick={() => onAction('request_fu', {})} cls="bg-amber-600">Minta Sales Follow Up</ActBtn>
        <ActBtn onClick={() => setRevising((v) => !v)} cls="bg-violet-600">Revisi Analisa AI</ActBtn>
      </div>

      {revising && (
        <div className="border border-violet-200 rounded p-3 space-y-2 bg-white">
          <select className="w-full border rounded px-2 py-1 text-xs"
            value={rev.corrected_root_cause}
            onChange={(e) => setRev({ ...rev, corrected_root_cause: e.target.value })}>
            <option value="">— Kategori issue yang benar —</option>
            {ROOT_CAUSES.map((rc) => <option key={rc} value={rc}>{rc}</option>)}
          </select>
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Alasan sebenarnya"
            value={rev.corrected_reason} onChange={(e) => setRev({ ...rev, corrected_reason: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Catatan untuk sales"
            value={rev.note} onChange={(e) => setRev({ ...rev, note: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Status akhir (mis. lost / recovered)"
            value={rev.final_status} onChange={(e) => setRev({ ...rev, final_status: e.target.value })} />
          <button className="px-3 py-1.5 rounded bg-violet-600 text-white text-xs"
            onClick={() => { onAction('revise_ai', rev); setRevising(false); }}>
            Simpan Revisi
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[11px] uppercase text-slate-400 font-medium">{label}</div>
      <div className="text-slate-700 whitespace-pre-wrap">{String(value)}</div>
    </div>
  );
}
function ActBtn({ onClick, cls, children }) {
  return <button onClick={onClick} className={`px-2.5 py-1 rounded text-white text-xs ${cls}`}>{children}</button>;
}
```

> Catatan eksekutor: konfirmasi helper `api(path, opts)` ada di `frontend/src/lib/api` dan mengembalikan JSON ter-parse (pola sama dipakai di halaman lotus-inbox). Jika ekspor bernama berbeda (mis. hanya `fetcher`), sesuaikan import — perilaku (POST + parse JSON) yang dipertahankan.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/supervisor-control/DiagnosisPanel.jsx
git commit -m "feat(supervisor-control): DiagnosisPanel component"
```

---

## Task 8: Komponen `LeadRow`

Satu baris lead: badge tier, nama customer, PIC, durasi sinyal, last message, chip root cause, tombol aksi cepat, toggle expand → render `DiagnosisPanel`.

**Files:**
- Create: `frontend/src/components/supervisor-control/LeadRow.jsx`

- [ ] **Step 1: Implementasi komponen**

```jsx
// frontend/src/components/supervisor-control/LeadRow.jsx
import { useState } from 'react';
import Link from 'next/link';
import DiagnosisPanel from './DiagnosisPanel';

const TIER_STYLE = {
  P1: 'bg-rose-100 text-rose-700 border-rose-300',
  P2: 'bg-amber-100 text-amber-700 border-amber-300',
  P3: 'bg-yellow-50 text-yellow-700 border-yellow-200',
};

function durasiText(it) {
  if (it.never_responded) return 'belum direspons';
  if (it.awaiting_sales_reply_min != null) return `belum dibalas ${Math.round(it.awaiting_sales_reply_min)} mnt`;
  if (it.awaiting_customer_reply_min != null) return `cust diam ${Math.round(it.awaiting_customer_reply_min)} mnt`;
  return '—';
}

export default function LeadRow({ item, onAction }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-100">
      <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
        <span className={`px-1.5 py-0.5 rounded border text-[11px] font-bold ${TIER_STYLE[item.tier] || ''}`}>{item.tier}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800 truncate">{item.cust_name || '(tanpa nama)'}</span>
            {item.pic_name && <span className="text-xs text-slate-400">PIC: {item.pic_name}</span>}
            {item.root_cause_tag && <span className="text-[11px] px-1.5 rounded bg-slate-100 text-slate-500">{item.root_cause_tag}</span>}
          </div>
          <div className="text-xs text-slate-500 truncate">
            {item.last_is_inbound ? '⬅︎ ' : '➡︎ '}{item.last_message || ''}
          </div>
        </div>
        <span className="text-xs text-rose-600 whitespace-nowrap">{durasiText(item)}</span>
        <div className="flex gap-1.5">
          <Link href={`/lotus-inbox/${item.lotus_id}`} className="px-2 py-1 rounded bg-sky-600 text-white text-xs">Chat</Link>
          <button onClick={() => onAction('ack', { note: 'analisa sesuai' })} className="px-2 py-1 rounded bg-emerald-600 text-white text-xs">Ack</button>
          <button onClick={() => setOpen((v) => !v)} className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-xs">{open ? '▴' : '▾ Diagnosa'}</button>
        </div>
      </div>
      {open && <DiagnosisPanel lotusId={item.lotus_id} onAction={onAction} />}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/supervisor-control/LeadRow.jsx
git commit -m "feat(supervisor-control): LeadRow component"
```

---

## Task 9: Halaman queue `/supervisor-control`

**Files:**
- Create: `frontend/src/pages/supervisor-control/index.js`

- [ ] **Step 1: Implementasi halaman**

```jsx
// frontend/src/pages/supervisor-control/index.js
import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import LeadRow from '@/components/supervisor-control/LeadRow';

const GROUPS = [
  { key: 'all',                 label: 'Semua' },
  { key: 'sales_response_risk', label: 'Sales Response Risk' },
  { key: 'follow_up_customer',  label: 'Follow Up Customer' },
  { key: 'lead_stuck',          label: 'Lead Stuck' },
];

export default function SupervisorControl() {
  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';
  const [group, setGroup] = useState('all');
  const url = `/api/supervisor-control/queue${group === 'all' ? '' : `?group=${group}`}`;
  const q = useSWR(isAdmin ? url : null, fetcher, { refreshInterval: 60_000 });

  async function handleAction(lotusId, action, payload) {
    await api(`/api/supervisor-control/lead/${lotusId}/action`, {
      method: 'POST', body: JSON.stringify({ action, ...payload }),
    });
    q.mutate();
  }

  if (me.data && !isAdmin) {
    return <Layout title="Supervisor Control — Tiara">
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">Halaman ini hanya untuk admin.</div>
    </Layout>;
  }

  const items = q.data?.items || [];
  const counts = q.data?.counts || {};

  return (
    <Layout title="Supervisor Control — Tiara">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Supervisor Control — Lead Macet</h1>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>🔴 {counts.P1 || 0} · 🟠 {counts.P2 || 0} · 🟡 {counts.P3 || 0}</span>
            <button onClick={() => q.mutate()} className="px-2 py-1 rounded bg-slate-100">Refresh</button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {GROUPS.map((g) => (
            <button key={g.key} onClick={() => setGroup(g.key)}
              className={`px-3 py-1 rounded text-xs ${group === g.key ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600'}`}>
              {g.label}
            </button>
          ))}
        </div>

        {q.error && <div className="text-sm text-rose-600">Gagal memuat: {q.error.message}</div>}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {items.length === 0 && !q.isLoading && (
            <div className="px-4 py-10 text-center text-sm text-slate-400">Tidak ada lead macet 🎉</div>
          )}
          {items.map((it) => (
            <LeadRow key={it.lotus_id} item={it} onAction={(a, p) => handleAction(it.lotus_id, a, p)} />
          ))}
        </div>
        <div className="text-xs text-slate-400">Update otomatis tiap 60 detik · {items.length} lead</div>
      </div>
    </Layout>
  );
}
```

> Catatan eksekutor: pastikan `fetcher` & `api` diekspor dari `frontend/src/lib/api` (dikonfirmasi di Task 7). Jika `fetcher` menerima URL & mengembalikan JSON dan `api(url, opts)` melakukan fetch dgn credentials, tidak perlu perubahan.

- [ ] **Step 2: Build frontend (verifikasi kompilasi)**

Run: `cd frontend && npm run build`
Expected: build sukses, halaman `/supervisor-control` muncul di daftar route tanpa error.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/supervisor-control/index.js
git commit -m "feat(supervisor-control): queue page with filter + auto-refresh"
```

---

## Task 10: Verifikasi end-to-end & deploy

**Files:** none (operasional)

- [ ] **Step 1: Restart backend & cek boot**

Run: `pm2 restart crm-pilot-backend && pm2 logs crm-pilot-backend --lines 20 --nostream`
Expected: boot bersih di port 3009, tanpa error route/SQL.

- [ ] **Step 2: Smoke test endpoint queue (sebagai admin, via sesi browser)**

Buka `https://salesai.prestisa.net/supervisor-control` sebagai admin.
Expected: daftar lead tampil ter-ranking; counter P1/P2/P3 terisi; filter group bekerja.

- [ ] **Step 3: Smoke test aksi**

Pada satu lead: klik **▾ Diagnosa** → **Generate AI Diagnosis** (muncul hasil Tier A), lalu klik **Ack**.
Expected: lead hilang dari queue setelah refresh; baris baru di `crm_lead_supervisor_actions`.

Verifikasi DB:
```bash
cd backend && node -e "const pg=require('./db/postgres');(async()=>{const r=await pg.query('select id,lotus_id,action,created_at from crm_lead_supervisor_actions order by id desc limit 5');console.log(r.rows);await pg.end()})()"
```
Expected: aksi `ack` terbaru tercatat.

- [ ] **Step 4: Commit catatan (bila ada penyesuaian)** — jika tidak ada perubahan kode, lewati.

---

## Self-Review (sudah dijalankan penulis plan)

- **Cakupan spec:** Grup 1 (Sales Response Risk) → sinyal `awaiting_sales_reply`/`never_responded` + group `sales_response_risk` ✓. Grup 2 (Follow Up) → `awaiting_customer_reply`/`fu_today`/`single_bubble` + group `follow_up_customer` ✓. Grup 3 (Lead Stuck) lite → chip `root_cause_tag`/`funnel_stage_lost` ✓ (taxonomy penuh = Phase 2, sesuai spec). Grup 4 (AI Diagnosis & Review) → `DiagnosisPanel` + aksi ack/resolve/revise_ai ✓. Grup 5 (Priority Queue) → `priorityTier` + sort ✓.
- **Placeholder:** dua "Catatan eksekutor" adalah langkah verifikasi nyata (cek skema / cek ekspor lib), bukan placeholder kerja.
- **Konsistensi tipe:** alias keluaran query (`last_message_from`, `last_message_at`, `inbound_count`, `fu_today`, `first_inbound_at`, `first_response_at`) cocok dgn field yang dibaca `deriveSignals`. Nama aksi (`ack`/`resolve`/`reassign`/`request_fu`/`revise_ai`) konsisten antara `VALID_ACTIONS`, test, dan komponen frontend.
- **Deferred (Phase 2, tidak dikerjakan):** Socket.io real-time, auto-learning dari `revise_ai`, FU-cycle numbering eksak, pre-warm top-N, pengiriman notifikasi "Minta FU".
