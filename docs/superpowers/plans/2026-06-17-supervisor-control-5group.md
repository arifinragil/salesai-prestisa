# Supervisor Control Panel — 5-Grup (Redesign) — Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Rewrite `/supervisor-control` menjadi panel 5-grup (Priority Queue + Sales Response Risk + Follow Up + Lead Stuck + AI Diagnosis/aksi), reuse sinyal + analyst-report + action endpoint yang ada. Tanpa migrasi.

**Spec:** `docs/superpowers/specs/2026-06-17-supervisor-control-5group-design.md`

---

## File Structure

| File | Tanggung jawab |
|---|---|
| `backend/services/supervisorPriority.js` (create) | Modul murni: `classify` → priority/groups/stuck bucket |
| `backend/__tests__/supervisorPriority.test.js` (create) | Unit test |
| `backend/routes/supervisorControl.js` (modify) | `GET /panel` endpoint |
| `backend/__tests__/supervisorControlPanel.test.js` (create) | Test panel (mock dua DB) |
| `frontend/src/components/supervisor-control/DiagnosisPanel.jsx` (modify) | Upgrade tampilan diagnosis + Suggested Action/Script (Tier B) |
| `frontend/src/components/supervisor-control/LeadCard.jsx` (create) | Baris lead + aksi + expand |
| `frontend/src/components/supervisor-control/GroupSection.jsx` (create) | Section grup (+ sub-bucket A/B/C/D) |
| `frontend/src/components/supervisor-control/PriorityQueue.jsx` (create) | Antrian P1/P2/P3 |
| `frontend/src/pages/supervisor-control/index.js` (rewrite) | Rakit panel |

---

## Task P1: Modul murni `supervisorPriority.js` (TDD)

**Files:** Create `backend/services/supervisorPriority.js`, `backend/__tests__/supervisorPriority.test.js`

- [ ] **Step 1: Test (gagal)**

```js
// backend/__tests__/supervisorPriority.test.js
const { classify, STUCK_MAP } = require('../services/supervisorPriority');
const base = (o = {}) => ({ status: 'active', never_responded: false, awaiting_sales_reply_min: null,
  awaiting_customer_reply_min: null, first_response_lag_min: null, single_bubble: false, fu_status: 'done',
  lead_temperature: 'warm', lead_score: 10, last_intent: null, customer_intent: null, root_cause_tag: null,
  funnel_stage_lost: null, asked_price: false, ...o });

describe('priority', () => {
  test('belum direspons → P1 + sales_response_risk', () => {
    const r = classify(base({ never_responded: true }));
    expect(r.priority).toBe('P1'); expect(r.groups).toContain('sales_response_risk');
  });
  test('customer nunggu >10 mnt → P1', () => {
    expect(classify(base({ awaiting_sales_reply_min: 18 })).priority).toBe('P1');
  });
  test('customer diam >60 mnt → P2 + follow_up', () => {
    const r = classify(base({ awaiting_customer_reply_min: 120 }));
    expect(r.priority).toBe('P2'); expect(r.groups).toContain('follow_up');
  });
  test('FU overdue → P2', () => {
    expect(classify(base({ fu_status: 'overdue' })).priority).toBe('P2');
  });
  test('single bubble → P3 + follow_up', () => {
    const r = classify(base({ single_bubble: true }));
    expect(r.priority).toBe('P3'); expect(r.groups).toContain('follow_up');
  });
  test('tidak ada sinyal → priority null', () => {
    expect(classify(base()).priority).toBeNull();
  });
  test('status closed → null semua', () => {
    expect(classify(base({ status: 'closed', never_responded: true }).priority)).toBeNull();
  });
});

describe('lead_stuck bucket', () => {
  test('harga_terlalu_mahal → bucket A', () => {
    const r = classify(base({ root_cause_tag: 'harga_terlalu_mahal' }));
    expect(r.groups).toContain('lead_stuck'); expect(r.stuck_bucket).toBe('A');
    expect(r.stuck_label).toMatch(/harga/i);
  });
  test('respon_lambat → bucket B', () => {
    expect(classify(base({ root_cause_tag: 'respon_lambat' })).stuck_bucket).toBe('B');
  });
  test('barang_tidak_tersedia → bucket C', () => {
    expect(classify(base({ root_cause_tag: 'barang_tidak_tersedia' })).stuck_bucket).toBe('C');
  });
  test('funnel_stage tanpa map dikenal → bucket D', () => {
    expect(classify(base({ funnel_stage_lost: 'quotation' })).stuck_bucket).toBe('D');
  });
  test('sudah_closing → bukan lead_stuck', () => {
    const r = classify(base({ root_cause_tag: 'sudah_closing' }));
    expect(r.groups).not.toContain('lead_stuck'); expect(r.stuck_bucket).toBeNull();
  });
});
```

- [ ] **Step 2:** `cd backend && npx jest supervisorPriority -i` → FAIL.

- [ ] **Step 3: Implementasi**

```js
// backend/services/supervisorPriority.js
// Logika murni Supervisor Control Panel: tentukan priority (P1/P2/P3), groups, dan
// bucket Lead Stuck (A/B/C/D) dari sinyal + field analyst. Tanpa DB.

const STUCK_MAP = {
  harga_terlalu_mahal:   { bucket: 'A', label: 'Keberatan harga' },
  window_shopping:       { bucket: 'A', label: 'Masih tanya-tanya / window shopping' },
  kompetitor:            { bucket: 'A', label: 'Bandingkan vendor' },
  ragu_kredibilitas:     { bucket: 'A', label: 'Ragu kredibilitas' },
  respon_lambat:         { bucket: 'B', label: 'Respon lambat (sales)' },
  info_produk_kurang:    { bucket: 'B', label: 'Kurang gali kebutuhan / info produk' },
  barang_tidak_tersedia: { bucket: 'C', label: 'Stok kosong' },
  ekspektasi_design:     { bucket: 'C', label: 'Desain kurang cocok' },
  area_pengiriman:       { bucket: 'C', label: 'Kendala area pengiriman' },
  timing_pengiriman:     { bucket: 'C', label: 'Kendala waktu pengiriman' },
  bukan_lead:            { bucket: 'D', label: 'Bukan lead / proses' },
  lainnya:               { bucket: 'D', label: 'Lainnya (proses)' },
};

const INQUIRY_RE = /tanya|harga|price|info|nanya|inquiry/i;
const HIGH_SCORE = 60;

function num(v) { const n = Number(v); return (v == null || Number.isNaN(n)) ? null : n; }

function classify(lead) {
  const status = lead.status || 'active';
  if (status !== 'active') return { priority: null, groups: [], stuck_bucket: null, stuck_label: null };

  const asr = num(lead.awaiting_sales_reply_min);
  const acr = num(lead.awaiting_customer_reply_min);
  const lag = num(lead.first_response_lag_min);
  const score = num(lead.lead_score);
  const hot = /hot/i.test(String(lead.lead_temperature || ''));
  const asked = !!lead.asked_price;
  const inquiry = INQUIRY_RE.test(String(lead.last_intent || '')) || INQUIRY_RE.test(String(lead.customer_intent || ''));
  const fuIncomplete = lead.fu_status === 'overdue';
  const stuck = !!(lead.root_cause_tag || lead.funnel_stage_lost) && lead.root_cause_tag !== 'sudah_closing';

  const groups = [];
  if (lead.never_responded || asr != null || (lag != null && lag > 1)) groups.push('sales_response_risk');
  if (acr != null || ['overdue', 'pending', 'fresh'].includes(lead.fu_status) || lead.single_bubble) groups.push('follow_up');
  if (stuck) groups.push('lead_stuck');

  const p1 = lead.never_responded || (asr != null && asr > 10) || (asked && asr != null);
  const p2 = (acr != null && acr > 60) || fuIncomplete || ((hot || (score != null && score >= HIGH_SCORE)) && stuck);
  const p3 = lead.single_bubble || inquiry || groups.length > 0;

  let priority = null;
  if (!groups.length && !p1) priority = null;
  else if (p1) priority = 'P1';
  else if (p2) priority = 'P2';
  else if (p3) priority = 'P3';

  let stuck_bucket = null, stuck_label = null;
  if (stuck) {
    const m = STUCK_MAP[lead.root_cause_tag];
    if (m) { stuck_bucket = m.bucket; stuck_label = m.label; }
    else { stuck_bucket = 'D'; stuck_label = lead.funnel_stage_lost ? `Proses: ${lead.funnel_stage_lost}` : 'Proses'; }
  }

  return { priority, groups, stuck_bucket, stuck_label };
}

module.exports = { classify, STUCK_MAP };
```

- [ ] **Step 4:** `npx jest supervisorPriority -i` → PASS.
- [ ] **Step 5: Commit**
```bash
cd /home/krttpt/crm && git add backend/services/supervisorPriority.js backend/__tests__/supervisorPriority.test.js && git commit -m "feat(supervisor-control): pure priority/groups/stuck classifier with tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P2: Endpoint `GET /api/supervisor-control/panel`

**Files:** Modify `backend/routes/supervisorControl.js`; Create `backend/__tests__/supervisorControlPanel.test.js`

Konteks: `supervisorControl.js` saat ini admin-only, punya `POST /lead/:id/action`. Endpoint baru membaca dua DB: `lotus` (contacts/messages) + `pg` (crm_lotus_state). Import yang dibutuhkan: `pg` sudah ada; tambah `const lotus = require('../db/lotus')`, `const { followupState } = require('../services/lotusFollowup')`, `const { classify } = require('../services/supervisorPriority')`, `const { tabsForItem } = require('../services/lotusTabs')` (untuk asked_price regex kita inline saja).

- [ ] **Step 1: Test (gagal)**

```js
// backend/__tests__/supervisorControlPanel.test.js
jest.mock('../db/postgres');
jest.mock('../db/lotus');
jest.mock('../middleware/auth', () => ({ requireStaff: (req, _res, next) => next() }));
const pg = require('../db/postgres');
const lotus = require('../db/lotus');
const express = require('express');
const request = require('supertest');

function appWith(staff) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/supervisor-control', require('../routes/supervisorControl'));
  return app;
}
const ADMIN = { staff_id: 1, role: 'admin' };
const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
afterEach(() => jest.clearAllMocks());

describe('GET /panel', () => {
  test('403 non-admin', async () => {
    const res = await request(appWith({ staff_id: 2, role: 'operator' })).get('/api/supervisor-control/panel');
    expect(res.status).toBe(403);
  });

  test('rakit priority_queue + groups', async () => {
    lotus.query.mockResolvedValue({ rows: [
      { lotus_id: 'A', cust_number: '1', cust_name: 'Ani', business_number: '628',
        last_message: 'harganya brp kak?', last_message_from: 'inbound', last_message_at: minAgo(20),
        last_inbound_at: minAgo(20), last_outbound_at: null, first_inbound_at: minAgo(20),
        inbound_count: 1, fu_count_today: 0, assign_to_user_name: 'Rina' },
    ] });
    pg.query.mockResolvedValue({ rows: [
      { lotus_id: 'A', status: 'active', assigned_staff_id: 7, root_cause_tag: null, funnel_stage_lost: null,
        lead_temperature: 'warm', lead_score: 10, last_intent: 'tanya_harga' },
    ] });
    const res = await request(appWith(ADMIN)).get('/api/supervisor-control/panel');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.priority_queue)).toBe(true);
    const ids = res.body.priority_queue.map((x) => x.lotus_id);
    expect(ids).toContain('A'); // never_responded (no outbound) → P1
    const a = res.body.priority_queue.find((x) => x.lotus_id === 'A');
    expect(a.priority).toBe('P1');
    expect(res.body.groups.sales_response_risk.map((x) => x.lotus_id)).toContain('A');
  });
});
```

- [ ] **Step 2:** `npx jest supervisorControlPanel -i` → FAIL.

- [ ] **Step 3: Implementasi** — tambahkan requires di atas file (setelah require yang ada):
```js
const lotus = require('../db/lotus');
const { followupState } = require('../services/lotusFollowup');
const { classify } = require('../services/supervisorPriority');
```
Lalu tambahkan handler SEBELUM `module.exports`:
```js
const PRICE_RE = /harga|berapa|price|brp/i;
const GROUP_KEYS = ['sales_response_risk', 'follow_up', 'lead_stuck'];

// GET /panel — lead aktif dalam scope, dirakit jadi priority queue + 3 grup.
router.get('/panel', async (req, res, next) => {
  try {
    const isAdmin = req.staff?.role === 'admin'; // selalu true (guard), tapi scope toggle:
    const scope = req.query.scope;
    const { rows: contacts } = await lotus.query(
      `WITH recent AS (
         SELECT c.lotus_id, c.cust_number, c.cust_name, c.business_number, c.assign_to_user_name,
                c.last_message, c.last_message_from, c.last_message_at, c.last_inbound_at
         FROM contacts c
         WHERE GREATEST(c.last_message_at, c.last_inbound_at) >= now() - interval '14 days'
         ORDER BY GREATEST(c.last_message_at, c.last_inbound_at) DESC NULLS LAST
         LIMIT 1000
       )
       SELECT r.*,
              COALESCE(lm.direction, r.last_message_from) AS last_message_from,
              COALESCE(lm.received_at, r.last_message_at) AS last_message_at,
              fim.received_at AS first_inbound_at,
              lo.received_at  AS last_outbound_at,
              fo.received_at  AS first_outbound_at,
              COALESCE(ic.n, 0) AS inbound_count,
              COALESCE(ft.n, 0) AS fu_count_today
       FROM recent r
       LEFT JOIN LATERAL (SELECT received_at, direction FROM messages m WHERE m.cust_number=r.cust_number ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1) lm ON true
       LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='inbound' ORDER BY received_at ASC NULLS LAST, id ASC LIMIT 1) fim ON true
       LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' ORDER BY received_at DESC NULLS LAST, id DESC LIMIT 1) lo ON true
       LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' ORDER BY received_at ASC NULLS LAST, id ASC LIMIT 1) fo ON true
       LEFT JOIN LATERAL (SELECT COUNT(*) n FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='inbound') ic ON true
       LEFT JOIN LATERAL (SELECT COUNT(*) n FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.received_at::date = now()::date) ft ON true`
    );
    const ids = contacts.map((c) => c.lotus_id);
    const stateMap = await getStateMap(ids);
    const now = new Date();
    const minsSince = (ts) => ts ? (now.getTime() - new Date(ts).getTime()) / 60000 : null;

    const items = [];
    for (const c of contacts) {
      const s = stateMap.get(c.lotus_id) || {};
      if ((s.status || 'active') !== 'active') continue;
      if (scope === 'mine' && (s.assigned_staff_id ?? null) !== req.staff.staff_id) continue;

      const inbound = /^(in|customer)/i.test(String(c.last_message_from || ''));
      const fu = followupState({ first_inbound_at: s.first_inbound_at || c.first_inbound_at, last_outbound_at: c.last_outbound_at }, now);
      const lead = {
        status: s.status || 'active',
        never_responded: !c.last_outbound_at,
        awaiting_sales_reply_min: inbound ? minsSince(c.last_message_at) : null,
        awaiting_customer_reply_min: !inbound ? minsSince(c.last_message_at) : null,
        first_response_lag_min: (c.first_inbound_at && c.first_outbound_at) ? minsSince(c.first_inbound_at) - minsSince(c.first_outbound_at) : null,
        single_bubble: Number(c.inbound_count) === 1,
        fu_status: fu.status,
        lead_temperature: s.lead_temperature, lead_score: s.lead_score,
        last_intent: s.last_intent, customer_intent: s.customer_intent,
        root_cause_tag: s.root_cause_tag, funnel_stage_lost: s.funnel_stage_lost,
        asked_price: PRICE_RE.test(String(c.last_message || '')),
      };
      const cls = classify(lead);
      items.push({
        lotus_id: c.lotus_id, cust_name: c.cust_name, pic_name: s.assigned_staff_name || c.assign_to_user_name || null,
        lead_in_at: lead.first_inbound_at = (s.first_inbound_at || c.first_inbound_at), last_message: c.last_message,
        last_message_from: c.last_message_from, last_message_at: c.last_message_at,
        awaiting_min: lead.awaiting_sales_reply_min ?? lead.awaiting_customer_reply_min, status: lead.status,
        priority: cls.priority, groups: cls.groups, stuck_bucket: cls.stuck_bucket, stuck_label: cls.stuck_label,
        fu_status: fu.status, fu_current_cycle: fu.current_cycle, fu_count_today: Number(c.fu_count_today) || 0,
        last_outbound_at: c.last_outbound_at, never_responded: lead.never_responded,
        root_cause_tag: s.root_cause_tag, funnel_stage_lost: s.funnel_stage_lost, lead_status: s.lead_status,
        controllability: s.controllability, sales_handling: s.sales_handling, evidence_quote: s.evidence_quote,
        analyst_report_generated_at: s.analyst_report_generated_at,
      });
    }

    const RANK = { P1: 0, P2: 1, P3: 2 };
    const priority_queue = items.filter((i) => i.priority)
      .sort((a, b) => (RANK[a.priority] - RANK[b.priority]) || ((b.awaiting_min || 0) - (a.awaiting_min || 0)));

    const groups = { sales_response_risk: [], follow_up: [], lead_stuck: { A: [], B: [], C: [], D: [] } };
    for (const i of items) {
      if (i.groups.includes('sales_response_risk')) groups.sales_response_risk.push(i);
      if (i.groups.includes('follow_up')) groups.follow_up.push(i);
      if (i.groups.includes('lead_stuck') && i.stuck_bucket) groups.lead_stuck[i.stuck_bucket].push(i);
    }
    res.json({
      priority_queue, groups,
      counts: { P1: priority_queue.filter((i) => i.priority === 'P1').length,
                P2: priority_queue.filter((i) => i.priority === 'P2').length,
                P3: priority_queue.filter((i) => i.priority === 'P3').length,
                total: items.length },
    });
  } catch (e) { next(e); }
});
```
> Catatan eksekutor: `getStateMap` ada di `lotusInbox.js`, BUKAN di `supervisorControl.js`. Tambahkan helper lokal `getStateMap` di `supervisorControl.js` (salin pola: `SELECT * FROM crm_lotus_state WHERE lotus_id = ANY($1::text[])` → Map by lotus_id). `s.assigned_staff_name` mungkin tidak ada di crm_lotus_state — kalau tidak ada, pakai `c.assign_to_user_name` saja (hapus referensi assigned_staff_name).

- [ ] **Step 4:** `npx jest supervisorControlPanel supervisorControl supervisorPriority -i` → PASS semua.
- [ ] **Step 5: Verifikasi query nyata**
```bash
cd /home/krttpt/crm/backend && node -e "const lotus=require('./db/lotus');(async()=>{try{const r=await lotus.query(\"WITH recent AS (SELECT c.lotus_id,c.cust_number,c.last_message,c.last_message_from,c.last_message_at,c.last_inbound_at FROM contacts c WHERE GREATEST(c.last_message_at,c.last_inbound_at)>=now()-interval '14 days' LIMIT 3) SELECT r.lotus_id, fim.received_at first_inbound, lo.received_at last_out, ft.n fu_today FROM recent r LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='inbound' ORDER BY received_at ASC LIMIT 1) fim ON true LEFT JOIN LATERAL (SELECT received_at FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' ORDER BY received_at DESC LIMIT 1) lo ON true LEFT JOIN LATERAL (SELECT COUNT(*) n FROM messages m WHERE m.cust_number=r.cust_number AND m.direction='outbound' AND m.received_at::date=now()::date) ft ON true\");console.log(r.rows);}catch(e){console.error('ERR',e.message)}finally{await lotus.end()}})()"
```
Expected: rows tanpa error. Jika error kolom, sesuaikan (pertahankan alias).
- [ ] **Step 6: Commit**
```bash
cd /home/krttpt/crm && git add backend/routes/supervisorControl.js backend/__tests__/supervisorControlPanel.test.js && git commit -m "feat(supervisor-control): GET /panel (priority queue + 5 groups)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P3: DiagnosisPanel upgrade

**Files:** Modify `frontend/src/components/supervisor-control/DiagnosisPanel.jsx`

Tampilkan diagnosis dari field tersimpan (props `lead`) + tombol "Suggested Action/Script" yang fetch Tier B on-demand. Pertahankan tombol aksi + form Revisi.

- [ ] **Step 1: Implementasi** — ganti isi file:

```jsx
// frontend/src/components/supervisor-control/DiagnosisPanel.jsx
import { useState } from 'react';
import { api } from '@/lib/api';

const ROOT_CAUSES = ['harga_terlalu_mahal','barang_tidak_tersedia','respon_lambat','info_produk_kurang',
  'ekspektasi_design','area_pengiriman','timing_pengiriman','kompetitor','ragu_kredibilitas',
  'window_shopping','sudah_closing','bukan_lead','lainnya'];

const HANDLING_LABEL = { discovery: 'Gali kebutuhan', recommendation: 'Rekomendasi produk',
  quotation_quality: 'Kualitas penawaran', objection_handling: 'Tangani keberatan', cta: 'Call-to-action', follow_up: 'Follow up' };

export default function DiagnosisPanel({ lead, onAction }) {
  const [tierB, setTierB] = useState(null);
  const [loadingB, setLoadingB] = useState(false);
  const [error, setError] = useState(null);
  const [revising, setRevising] = useState(false);
  const [rev, setRev] = useState({ corrected_root_cause: '', corrected_reason: '', final_status: '', note: '' });

  const gaps = lead.sales_handling && typeof lead.sales_handling === 'object'
    ? Object.entries(lead.sales_handling).filter(([, v]) => v === false).map(([k]) => HANDLING_LABEL[k] || k) : [];

  async function loadAction() {
    setLoadingB(true); setError(null);
    try {
      const d = await api(`/api/lotus-inbox/contacts/${lead.lotus_id}/analyst-report`, { method: 'POST', body: { tier: 'B' } });
      setTierB(d.analyst_summary_md || d.summary || 'Tidak ada ringkasan.');
    } catch (e) { setError(e.message || 'Gagal'); } finally { setLoadingB(false); }
  }

  return (
    <div className="bg-slate-50 border-t border-slate-200 px-4 py-3 space-y-2 text-sm">
      <Field label="AI Diagnosis" value={lead.lead_status || lead.customer_intent} />
      <Field label="Root Issue" value={lead.stuck_label || lead.root_cause_tag || lead.funnel_stage_lost} />
      {gaps.length > 0 && <Field label="Gap Sales Handling" value={gaps.join(' · ')} />}
      <Field label="Controllability" value={lead.controllability} />
      {lead.evidence_quote && <Field label="Bukti" value={`"${lead.evidence_quote}"`} />}

      <div>
        <div className="text-[11px] uppercase text-slate-400 font-medium">Suggested Action / Script</div>
        {!tierB && !loadingB && <button onClick={loadAction} className="mt-1 px-2.5 py-1 rounded bg-sky-600 text-white text-xs">Tampilkan saran AI</button>}
        {loadingB && <div className="text-slate-500">Memuat…</div>}
        {error && <div className="text-rose-600">{error}</div>}
        {tierB && <div className="text-slate-700 whitespace-pre-wrap mt-1">{tierB}</div>}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <ActBtn onClick={() => onAction('ack', { note: 'analisa sesuai' })} cls="bg-emerald-600">Ack</ActBtn>
        <ActBtn onClick={() => onAction('resolve', { note: 'sudah ditindaklanjuti' })} cls="bg-slate-700">Resolve</ActBtn>
        <ActBtn onClick={() => onAction('request_fu', {})} cls="bg-amber-600">Minta FU</ActBtn>
        <ActBtn onClick={() => setRevising((v) => !v)} cls="bg-violet-600">Revisi Analisa AI</ActBtn>
      </div>

      {revising && (
        <div className="border border-violet-200 rounded p-3 space-y-2 bg-white">
          <select className="w-full border rounded px-2 py-1 text-xs" value={rev.corrected_root_cause}
            onChange={(e) => setRev({ ...rev, corrected_root_cause: e.target.value })}>
            <option value="">— Kategori issue yang benar —</option>
            {ROOT_CAUSES.map((rc) => <option key={rc} value={rc}>{rc}</option>)}
          </select>
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Alasan sebenarnya"
            value={rev.corrected_reason} onChange={(e) => setRev({ ...rev, corrected_reason: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Catatan untuk sales"
            value={rev.note} onChange={(e) => setRev({ ...rev, note: e.target.value })} />
          <input className="w-full border rounded px-2 py-1 text-xs" placeholder="Status akhir"
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
  return (<div><div className="text-[11px] uppercase text-slate-400 font-medium">{label}</div><div className="text-slate-700 whitespace-pre-wrap">{String(value)}</div></div>);
}
function ActBtn({ onClick, cls, children }) { return <button onClick={onClick} className={`px-2.5 py-1 rounded text-white text-xs ${cls}`}>{children}</button>; }
```

- [ ] **Step 2: Commit**
```bash
git add frontend/src/components/supervisor-control/DiagnosisPanel.jsx
git commit -m "feat(supervisor-control): DiagnosisPanel shows stored diagnosis + on-demand Tier B action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P4: LeadCard + GroupSection + PriorityQueue

**Files:** Create `frontend/src/components/supervisor-control/LeadCard.jsx`, `GroupSection.jsx`, `PriorityQueue.jsx`

- [ ] **Step 1: LeadCard.jsx**
```jsx
// frontend/src/components/supervisor-control/LeadCard.jsx
import { useState } from 'react';
import DiagnosisPanel from './DiagnosisPanel';

const TIER = { P1: 'bg-rose-100 text-rose-700 border-rose-300', P2: 'bg-amber-100 text-amber-700 border-amber-300', P3: 'bg-yellow-50 text-yellow-700 border-yellow-200' };
function dur(it) {
  if (it.never_responded) return 'belum direspons';
  if (it.last_message_from && /^(in|customer)/i.test(it.last_message_from)) return `belum dibalas ${Math.round(it.awaiting_min || 0)} mnt`;
  return `cust diam ${Math.round(it.awaiting_min || 0)} mnt`;
}
export default function LeadCard({ item, onAction, extra }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-100">
      <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
        {item.priority && <span className={`px-1.5 py-0.5 rounded border text-[11px] font-bold ${TIER[item.priority] || ''}`}>{item.priority}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800 truncate">{item.cust_name || '(tanpa nama)'}</span>
            {item.pic_name && <span className="text-xs text-slate-400">PIC: {item.pic_name}</span>}
            {item.stuck_label && <span className="text-[11px] px-1.5 rounded bg-slate-100 text-slate-500">{item.stuck_label}</span>}
          </div>
          <div className="text-xs text-slate-500 truncate">{/^(in|customer)/i.test(item.last_message_from || '') ? '⬅︎ ' : '➡︎ '}{item.last_message || ''}</div>
          {extra && <div className="text-[11px] text-slate-400 mt-0.5">{extra(item)}</div>}
        </div>
        <span className="text-xs text-rose-600 whitespace-nowrap">{dur(item)}</span>
        <div className="flex gap-1.5">
          <a href={`/lotus-inbox/${item.lotus_id}`} className="px-2 py-1 rounded bg-sky-600 text-white text-xs">Chat</a>
          <button onClick={() => onAction('ack', { note: 'analisa sesuai' })} className="px-2 py-1 rounded bg-emerald-600 text-white text-xs">Ack</button>
          <button onClick={() => setOpen((v) => !v)} className="px-2 py-1 rounded bg-slate-200 text-slate-700 text-xs">{open ? '▴' : '▾ Diagnosa'}</button>
        </div>
      </div>
      {open && <DiagnosisPanel lead={item} onAction={onAction} />}
    </div>
  );
}
```

- [ ] **Step 2: GroupSection.jsx**
```jsx
// frontend/src/components/supervisor-control/GroupSection.jsx
import LeadCard from './LeadCard';
export default function GroupSection({ title, icon, items = [], onAction, extra, buckets }) {
  const count = buckets ? Object.values(buckets).reduce((s, a) => s + a.length, 0) : items.length;
  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
        <span>{icon}</span><h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <span className="text-xs text-slate-400">({count})</span>
      </div>
      {count === 0 && <div className="px-4 py-6 text-center text-xs text-slate-400">Tidak ada lead</div>}
      {buckets ? (
        Object.entries(buckets).map(([b, arr]) => arr.length > 0 && (
          <div key={b}>
            <div className="px-4 py-1 bg-slate-100/60 text-[11px] font-semibold text-slate-500">{BUCKET_LABEL[b]}</div>
            {arr.map((it) => <LeadCard key={it.lotus_id} item={it} onAction={(a, p) => onAction(it.lotus_id, a, p)} extra={extra} />)}
          </div>
        ))
      ) : items.map((it) => <LeadCard key={it.lotus_id} item={it} onAction={(a, p) => onAction(it.lotus_id, a, p)} extra={extra} />)}
    </div>
  );
}
const BUCKET_LABEL = { A: 'A · Issue dari Customer', B: 'B · Issue dari Sales Handling', C: 'C · Issue dari Offer / Produk', D: 'D · Issue dari Proses' };
```

- [ ] **Step 3: PriorityQueue.jsx**
```jsx
// frontend/src/components/supervisor-control/PriorityQueue.jsx
import LeadCard from './LeadCard';
export default function PriorityQueue({ items = [], counts = {}, onAction }) {
  return (
    <div className="bg-white border-2 border-rose-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 flex items-center gap-2">
        <span>🎯</span><h2 className="text-sm font-semibold text-rose-800">Priority Lead Queue</h2>
        <span className="text-xs text-rose-600">🔴 {counts.P1 || 0} · 🟠 {counts.P2 || 0} · 🟡 {counts.P3 || 0}</span>
      </div>
      {items.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-400">Tidak ada lead prioritas 🎉</div>}
      {items.map((it) => <LeadCard key={it.lotus_id} item={it} onAction={(a, p) => onAction(it.lotus_id, a, p)}
        extra={(i) => `${i.fu_status === 'overdue' ? 'FU overdue · ' : ''}cycle FU ${i.fu_current_cycle}/3 · ${i.fu_count_today} FU hari ini`} />)}
    </div>
  );
}
```

- [ ] **Step 4: Commit**
```bash
git add frontend/src/components/supervisor-control/LeadCard.jsx frontend/src/components/supervisor-control/GroupSection.jsx frontend/src/components/supervisor-control/PriorityQueue.jsx
git commit -m "feat(supervisor-control): LeadCard + GroupSection + PriorityQueue components

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P5: Rewrite halaman `/supervisor-control`

**Files:** Rewrite `frontend/src/pages/supervisor-control/index.js`

- [ ] **Step 1: Implementasi**
```jsx
// frontend/src/pages/supervisor-control/index.js
import { useState } from 'react';
import useSWR from 'swr';
import Layout from '@/components/Layout';
import { fetcher, api } from '@/lib/api';
import PriorityQueue from '@/components/supervisor-control/PriorityQueue';
import GroupSection from '@/components/supervisor-control/GroupSection';

export default function SupervisorControl() {
  const me = useSWR('/api/auth/me', fetcher);
  const isAdmin = me.data?.user?.role === 'admin';
  const [scope, setScope] = useState('team');
  const [hidden, setHidden] = useState({});
  const url = isAdmin ? `/api/supervisor-control/panel${scope === 'mine' ? '?scope=mine' : ''}` : null;
  const panel = useSWR(url, fetcher, { refreshInterval: 60_000 });

  async function onAction(lotusId, action, payload) {
    await api(`/api/supervisor-control/lead/${lotusId}/action`, { method: 'POST', body: { action, ...payload } });
    if (action === 'ack' || action === 'resolve') setHidden((h) => ({ ...h, [lotusId]: true }));
    else panel.mutate();
  }
  const visible = (arr) => (arr || []).filter((i) => !hidden[i.lotus_id]);

  if (me.data && !isAdmin) return <Layout title="Supervisor Control — Tiara"><div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm text-rose-600">Halaman ini hanya untuk admin.</div></Layout>;

  const d = panel.data || {};
  const g = d.groups || {};
  const buckets = g.lead_stuck ? Object.fromEntries(Object.entries(g.lead_stuck).map(([k, v]) => [k, visible(v)])) : { A: [], B: [], C: [], D: [] };

  return (
    <Layout title="Supervisor Control — Tiara">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-800">Supervisor Control Panel</h1>
          <div className="flex gap-1.5">
            <button onClick={() => setScope('team')} className={`px-2 py-1 rounded text-xs ${scope === 'team' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Tim</button>
            <button onClick={() => setScope('mine')} className={`px-2 py-1 rounded text-xs ${scope === 'mine' ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Saya</button>
            <button onClick={() => panel.mutate()} className="px-2 py-1 rounded bg-slate-100 text-slate-600 text-xs">↻</button>
          </div>
        </div>
        {panel.error && <div className="text-sm text-rose-600">Gagal memuat: {panel.error.message}</div>}

        <PriorityQueue items={visible(d.priority_queue)} counts={d.counts || {}} onAction={onAction} />
        <GroupSection title="Sales Response Risk" icon="⚡" items={visible(g.sales_response_risk)} onAction={onAction} />
        <GroupSection title="Follow Up Customer" icon="🔁" items={visible(g.follow_up)} onAction={onAction}
          extra={(i) => `cycle FU ${i.fu_current_cycle}/3 · ${i.fu_count_today} FU hari ini${i.fu_status === 'overdue' ? ' · overdue' : ''}`} />
        <GroupSection title="Lead Stuck / Belum Closing" icon="🧩" buckets={buckets} onAction={onAction} />
        <div className="text-xs text-slate-400">Update tiap 60 detik · {d.counts?.total || 0} lead aktif</div>
      </div>
    </Layout>
  );
}
```

- [ ] **Step 2: Build**
Run: `cd /home/krttpt/crm/frontend && npm run build` → sukses.
- [ ] **Step 3: Commit**
```bash
cd /home/krttpt/crm && git add frontend/src/pages/supervisor-control/index.js && git commit -m "feat(supervisor-control): rewrite page as 5-group panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task P6: Verifikasi & deploy

- [ ] `cd backend && npx jest supervisorPriority supervisorControlPanel supervisorControl -i` → hijau.
- [ ] `pm2 restart crm-pilot-backend crm-pilot-frontend` → online.
- [ ] Smoke (admin): `https://salesai.prestisa.net/supervisor-control` → Priority Queue + 3 section tampil; expand Diagnosa; Ack menyembunyikan baris; toggle Tim/Saya.

---

## Self-Review (penulis plan)
- Cakupan: Grup 1/2/3/5 → classify + /panel + sections ✓. Grup 4 → DiagnosisPanel (stored + Tier B) ✓. Aksi → endpoint lama ✓. Bucket A/B/C/D → STUCK_MAP ✓. Priority rules sesuai spek user ✓.
- Konsistensi: field yang dibaca `classify` dirakit di /panel; tab/group keys konsisten; action keys konsisten frontend↔backend.
- Catatan: `getStateMap` harus dibuat lokal di supervisorControl.js (Step P2 note). Mapping A/B/C/D & intent = pendekatan (sesuai keputusan).
