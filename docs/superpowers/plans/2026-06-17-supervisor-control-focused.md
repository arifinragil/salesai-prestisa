# Supervisor Control (Focused) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Supersedes** the standalone plan `2026-06-17-supervisor-control-panel.md` (whose queue query was a non-viable cross-DB JOIN). Scope narrowed per decision: build the **AI Diagnosis + supervisor action/review layer**, reusing the Kanban lead queue + existing analyst-report. No new queue query.

**Goal:** Admin page `/supervisor-control` yang menampilkan lead (reuse `/api/lotus-inbox/contacts` + TabStrip), tiap lead bisa di-expand → **AI Diagnosis** (analyst-report Tier A) + **aksi supervisor** (Ack/Resolve/Minta FU/Revisi Analisa/Assign) yang dicatat ke `crm_lead_supervisor_actions` (migrasi 034, sudah applied).

**Reuse (jangan bangun ulang):** `/api/lotus-inbox/contacts` (queue + tab + scope), `/api/lotus-inbox/tab-counts`, `POST /api/lotus-inbox/contacts/:id/analyst-report` (Tier A), `TabStrip.jsx`, pola admin-guard `routes/supervisor.js`.

**Tech Stack:** Node/Express, PostgreSQL, Jest + supertest, Next.js + SWR + Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-17-supervisor-control-panel-design.md` (§4 Action loop + §Data model masih berlaku; §2 signal engine & §3 queue UI di-reuse dari Kanban).

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `backend/routes/supervisorControl.js` (create) | Admin route: `POST /lead/:lotus_id/action`, `GET /lead/:lotus_id/actions` |
| `backend/__tests__/supervisorControl.test.js` (create) | Test action endpoint (supertest + mock pg) |
| `backend/index.js` (modify) | Mount `/api/supervisor-control` |
| `frontend/src/components/supervisor-control/DiagnosisPanel.jsx` (create) | AI Diagnosis (analyst-report) + tombol aksi → POST action |
| `frontend/src/pages/supervisor-control/index.js` (create) | Halaman admin: reuse TabStrip + `/contacts`, expand → DiagnosisPanel |
| `frontend/src/components/Layout.jsx` (modify) | Nav item "Supervisor Control" |

---

## Task SC1: Backend route — action endpoint

**Files:**
- Create: `backend/routes/supervisorControl.js`
- Test: `backend/__tests__/supervisorControl.test.js`
- Modify: `backend/index.js`

- [ ] **Step 1: Tulis test yang gagal**

```js
// backend/__tests__/supervisorControl.test.js
jest.mock('../db/postgres');
const pg = require('../db/postgres');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/supervisor-control', require('../routes/supervisorControl'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin', username: 'boss' };

afterEach(() => jest.clearAllMocks());

describe('POST /lead/:id/action', () => {
  test('403 untuk non-admin', async () => {
    const res = await request(appWith({ staff_id: 2, role: 'operator' }))
      .post('/api/supervisor-control/lead/L1/action').send({ action: 'ack' });
    expect(res.status).toBe(403);
  });

  test('action tak dikenal → 400', async () => {
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action').send({ action: 'nope' });
    expect(res.status).toBe(400);
  });

  test('ack: insert log + update ack flag', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 10 }] }).mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action').send({ action: 'ack', note: 'sesuai' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.query.mock.calls[1][0]).toMatch(/UPDATE crm_lotus_state/i);
  });

  test('revise_ai: insert log saja (tanpa update ack)', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: 11 }] });
    const res = await request(appWith(ADMIN))
      .post('/api/supervisor-control/lead/L1/action')
      .send({ action: 'revise_ai', corrected_root_cause: 'harga_terlalu_mahal', corrected_reason: 'budget kecil', final_status: 'lost', note: 'sales kirim harga terlalu cepat' });
    expect(res.status).toBe(200);
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][0]).toMatch(/INSERT INTO crm_lead_supervisor_actions/i);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL**

Run: `cd backend && npx jest supervisorControl -i`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementasi route**

```js
// backend/routes/supervisorControl.js
// Supervisor Control — AI Diagnosis review + aksi supervisor. Admin-only.
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

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
        `UPDATE crm_lotus_state SET supervisor_ack_at = now(), supervisor_ack_by = $2 WHERE lotus_id = $1`,
        [lotus_id, req.staff.staff_id]
      );
    }
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { next(e); }
});

// GET /lead/:lotus_id/actions — histori aksi
router.get('/lead/:lotus_id/actions', async (req, res, next) => {
  try {
    const { rows } = await pg.query(
      `SELECT id, action, note, corrected_root_cause, corrected_reason, final_status, staff_id, created_at
       FROM crm_lead_supervisor_actions WHERE lotus_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.lotus_id]
    );
    res.json({ items: rows });
  } catch (e) { next(e); }
});

module.exports = router;
```

- [ ] **Step 4: Jalankan test, pastikan LULUS**

Run: `cd backend && npx jest supervisorControl -i`
Expected: PASS.

- [ ] **Step 5: Mount di index.js**

Setelah `const supervisorRoutes = require('./routes/supervisor');` tambah:
```js
const supervisorControlRoutes = require('./routes/supervisorControl');
```
Setelah `app.use('/api/supervisor', supervisorRoutes);` tambah:
```js
app.use('/api/supervisor-control', supervisorControlRoutes);
```

- [ ] **Step 6: Verifikasi boot + commit**

Run: `cd backend && node -e "require('./routes/supervisorControl'); console.log('ok')"`
Expected: `ok`.
```bash
cd /home/krttpt/crm && git add backend/routes/supervisorControl.js backend/__tests__/supervisorControl.test.js backend/index.js && git commit -m "feat(supervisor-control): admin action endpoint (ack/resolve/revise_ai)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task SC2: Frontend `DiagnosisPanel`

AI Diagnosis on-demand (analyst-report Tier A) + tombol aksi. `<DiagnosisPanel lotusId onAction onDone />`. `onAction(action, payload)` dipanggil parent untuk POST; `onDone()` dipanggil setelah ack/resolve agar parent menyembunyikan baris.

**Files:**
- Create: `frontend/src/components/supervisor-control/DiagnosisPanel.jsx`

- [ ] **Step 1: Implementasi**

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
          <Field label="Status Lead" value={report.lead_status} />
          <Field label="Intent" value={report.customer_intent} />
          <Field label="Root Issue" value={report.root_cause_tag || report.funnel_stage_lost} />
          <Field label="Controllability" value={report.controllability} />
          {report.evidence_quote && <Field label="Bukti" value={`"${report.evidence_quote}"`} />}
          {report.analyst_summary_md && <Field label="Ringkasan" value={report.analyst_summary_md} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <ActBtn onClick={() => onAction('ack', { note: 'analisa sesuai' })} cls="bg-emerald-600">Ack</ActBtn>
        <ActBtn onClick={() => onAction('resolve', { note: 'sudah ditindaklanjuti' })} cls="bg-slate-700">Resolve</ActBtn>
        <ActBtn onClick={() => onAction('request_fu', {})} cls="bg-amber-600">Minta FU</ActBtn>
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
            onClick={() => { onAction('revise_ai', rev); setRevising(false); }}>Simpan Revisi</button>
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

> Catatan eksekutor: konfirmasi `api(path, opts)` diekspor dari `frontend/src/lib/api` (dipakai di `pages/lotus-inbox/index.js`). Jika tidak, sesuaikan import (pertahankan perilaku POST + parse JSON).

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/supervisor-control/DiagnosisPanel.jsx
git commit -m "feat(supervisor-control): DiagnosisPanel (AI diagnosis + actions)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task SC3: Frontend page `/supervisor-control` + nav

Halaman admin yang reuse TabStrip + `/api/lotus-inbox/contacts` (scope team), tiap lead baris dengan expand → DiagnosisPanel. Ack/Resolve → POST action + sembunyikan baris (client-side).

**Files:**
- Create: `frontend/src/pages/supervisor-control/index.js`
- Modify: `frontend/src/components/Layout.jsx`

- [ ] **Step 1: Nav item (Layout.jsx)** — setelah entri `{ href: '/supervisor', ... }` tambah:
```jsx
  { href: '/supervisor-control', label: 'Supervisor Control', icon: '👁‍🗨', adminOnly: true },
```

- [ ] **Step 2: Halaman**

```jsx
// frontend/src/pages/supervisor-control/index.js
import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import TabStrip from '@/components/lotus-inbox/TabStrip';
import DiagnosisPanel from '@/components/supervisor-control/DiagnosisPanel';

export default function SupervisorControl() {
  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';
  const [tab, setTab] = useState('urgent');
  const [openId, setOpenId] = useState(null);
  const [hidden, setHidden] = useState({}); // lotus_id → true (ack/resolve)

  const listUrl = isAdmin ? `/api/lotus-inbox/contacts?tab=${tab}&limit=100` : null;
  const list = useSWR(listUrl, fetcher, { refreshInterval: 60_000 });
  const counts = useSWR(isAdmin ? '/api/lotus-inbox/tab-counts' : null, fetcher, { refreshInterval: 60_000 });

  async function handleAction(lotusId, action, payload) {
    await api(`/api/supervisor-control/lead/${lotusId}/action`, {
      method: 'POST', body: JSON.stringify({ action, ...payload }),
    });
    if (action === 'ack' || action === 'resolve') setHidden((h) => ({ ...h, [lotusId]: true }));
  }

  if (me.data && !isAdmin) {
    return <Layout title="Supervisor Control — Tiara">
      <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">Halaman ini hanya untuk admin.</div>
    </Layout>;
  }

  const items = (list.data?.items || []).filter((it) => !hidden[it.lotus_id]);

  return (
    <Layout title="Supervisor Control — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <h1 className="text-lg font-semibold text-slate-800">Supervisor Control — Review Lead</h1>
        <TabStrip tab={tab} counts={counts.data?.counts || {}} onChange={(t) => { setTab(t); setOpenId(null); }} />
        {list.error && <div className="text-sm text-rose-600">Gagal memuat: {list.error.message}</div>}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {items.length === 0 && !list.isLoading && (
            <div className="px-4 py-10 text-center text-sm text-slate-400">Tidak ada lead di tab ini 🎉</div>
          )}
          {items.map((it) => (
            <div key={it.lotus_id} className="border-b border-slate-100">
              <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-800 truncate">{it.cust_name || '(tanpa nama)'}
                    {it.lotus_assign_to && <span className="ml-2 text-xs text-slate-400">PIC: {it.lotus_assign_to}</span>}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{it.last_message_from === 'inbound' ? '⬅︎ ' : '➡︎ '}{it.last_body || ''}</div>
                </div>
                <a href={`/lotus-inbox/${it.lotus_id}`} className="px-2 py-1 rounded bg-sky-600 text-white text-xs">Chat</a>
                <button onClick={() => setOpenId(openId === it.lotus_id ? null : it.lotus_id)}
                  className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-xs">{openId === it.lotus_id ? '▴' : '▾ Diagnosa'}</button>
              </div>
              {openId === it.lotus_id && (
                <DiagnosisPanel lotusId={it.lotus_id} onAction={(a, p) => handleAction(it.lotus_id, a, p)} />
              )}
            </div>
          ))}
        </div>
        <div className="text-xs text-slate-400">Reuse antrian Kanban · update tiap 60 detik · {items.length} lead</div>
      </div>
    </Layout>
  );
}
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: sukses, `/supervisor-control` ter-compile.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/supervisor-control/index.js frontend/src/components/Layout.jsx
git commit -m "feat(supervisor-control): admin page reusing Kanban queue + diagnosis panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task SC4: Verifikasi & deploy

- [ ] **Step 1:** `cd backend && npx jest supervisorControl -i` → hijau.
- [ ] **Step 2:** `pm2 restart crm-pilot-backend crm-pilot-frontend` → keduanya online.
- [ ] **Step 3:** Smoke (admin): buka `https://salesai.prestisa.net/supervisor-control` → tab strip + daftar lead; klik "▾ Diagnosa" → Generate AI Diagnosis tampil; klik Ack → baris hilang; cek baris baru di `crm_lead_supervisor_actions`:
```bash
cd backend && node -e "const pg=require('./db/postgres');(async()=>{const r=await pg.query('select id,lotus_id,action,created_at from crm_lead_supervisor_actions order by id desc limit 5');console.log(r.rows);await pg.end()})()"
```

---

## Self-Review (penulis plan)

- **Cakupan:** aksi ack/resolve/reassign/request_fu/revise_ai → endpoint (SC1) ✓. AI Diagnosis reuse analyst-report (SC2) ✓. Antrian reuse `/contacts`+TabStrip (SC3) — no duplicate query ✓. revise_ai simpan koreksi sbg data latih (SC1 insert) ✓. ack/resolve set supervisor_ack_at (SC1) + sembunyikan baris (SC3 client-side) ✓.
- **Migrasi 034:** sudah applied (crm_lead_supervisor_actions + supervisor_ack_at/by ada).
- **Konsistensi:** action keys (ack/resolve/reassign/request_fu/revise_ai) konsisten antara VALID_ACTIONS, test, DiagnosisPanel, handleAction. Endpoint `/api/supervisor-control/lead/:id/action` konsisten frontend↔backend.
- **Keterbatasan MVP (dicatat):** ack menyembunyikan baris client-side saja (server set supervisor_ack_at tapi `/contacts` belum memfilter ack'd — enhancement). DiagnosisPanel render field analyst-report secara defensif (tampilkan yang ada).
