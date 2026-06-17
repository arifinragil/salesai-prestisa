# Supervisor Control Panel — 5-Grup (Redesign) — Design Spec

**Date:** 2026-06-17
**Project:** crm (salesai.prestisa.net)
**Status:** Approved — ready for writing-plans
**Replaces:** halaman `/supervisor-control` versi "focused" (TabStrip + DiagnosisPanel) dengan panel 5-grup.

## Goal

Ubah `/supervisor-control` jadi **control panel**, bukan report: supervisor melihat lead yang
"macet", tahu penyebabnya (AI Diagnosis), lalu langsung memberi tindakan/acknowledge ke sales.
5 grup utama (bukan banyak card kecil).

## Reuse (sudah ada — jangan bangun ulang)

| Kebutuhan | Sumber |
|---|---|
| Sinyal waktu (lama balas/belum dibalas/customer baru) | `services/lotusTabs.js` |
| FU cycle H+1/H+3/H+5 | `services/lotusFollowup.js` |
| AI Diagnosis Tier A (pre-warmed harian) | kolom `crm_lotus_state` (root_cause_tag/customer_reason, funnel_stage_lost, sales_handling, product_solution_fit, controllability, evidence_quote, lead_status, customer_intent) |
| AI narasi + Suggested Action/Script | `POST /contacts/:id/analyst-report` Tier B → `analyst_summary_md` (berisi "Corrective Action") |
| Aksi supervisor | `POST /api/supervisor-control/lead/:id/action` (ack/resolve/reassign/request_fu/revise_ai) + `crm_lead_supervisor_actions` |
| Dua-DB merge | pola `getStateMap` + LATERAL di `routes/lotusInbox.js` |

Tidak ada perubahan skema DB. Tidak ada perubahan prompt AI (Grup 3 = mapping dari field yang ada).

## Layout

Halaman scroll (`/supervisor-control`, admin-only), urut atas→bawah:
1. **🎯 Priority Lead Queue** — gabungan P1/P2/P3 (sorted P1→P3, lalu durasi tunggu terlama). "Selamatkan dulu."
2. **⚡ Sales Response Risk** (Grup 1) — section + tabel.
3. **🔁 Follow Up Customer** (Grup 2) — section + tabel.
4. **🧩 Lead Stuck / Belum Closing** (Grup 3) — section + tabel, dikelompokkan per bucket A/B/C/D.

Tiap baris lead → tombol aksi inline + **expand → AI Diagnosis box** (Grup 4).
Toggle scope **Tim / Saya** (admin). Auto-refresh 60 detik.

## Modul murni — `backend/services/supervisorPriority.js`

`classify(lead, now)` → `{ priority, groups, stuck_bucket, stuck_label }`. Tanpa DB, unit-tested.

Input `lead` (dirakit endpoint): `never_responded, awaiting_sales_reply_min, awaiting_customer_reply_min,
first_response_lag_min, single_bubble, fu_status, fu_current_cycle, lead_temperature, lead_score,
last_intent, customer_intent, root_cause_tag, funnel_stage_lost, asked_price, status`.

**Priority** (max severity; null bila status≠active):
- **P1**: `never_responded` · `awaiting_sales_reply_min > 10` · (`asked_price` & customer masih nunggu).
- **P2**: `awaiting_customer_reply_min > 60` · `fu_status === 'overdue'` (cycle belum lengkap) ·
  (high intent: `lead_temperature ~ hot` atau `lead_score >= 60`) & belum closing.
- **P3**: `single_bubble` · masih tanya-tanya (`last_intent`/`customer_intent` ~ tanya/inquiry) · sisanya yang actionable.

**Groups** (boleh lebih dari satu):
- `sales_response_risk`: `never_responded` atau `awaiting_sales_reply_min != null` atau `first_response_lag_min > 1`.
- `follow_up`: `awaiting_customer_reply_min != null` atau `fu_status ∈ {overdue,pending,fresh}` atau `single_bubble`.
- `lead_stuck`: ada `root_cause_tag` atau `funnel_stage_lost`, dan `root_cause_tag !== 'sudah_closing'`.

**Grup 3 bucket** (mapping `root_cause_tag` → A/B/C/D + label, `STUCK_MAP`):
- **A Customer**: harga_terlalu_mahal→"Keberatan harga", window_shopping→"Masih tanya-tanya / window shopping",
  kompetitor→"Bandingkan vendor", ragu_kredibilitas→"Ragu kredibilitas".
- **B Sales Handling**: respon_lambat→"Respon lambat", info_produk_kurang→"Kurang gali kebutuhan / info produk".
  (diperkaya gap `sales_handling`: discovery/recommendation/quotation_quality/objection_handling/cta/follow_up = false).
- **C Offer/Produk**: barang_tidak_tersedia→"Stok kosong", ekspektasi_design→"Desain kurang cocok",
  area_pengiriman→"Area kirim", timing_pengiriman→"Waktu kirim".
- **D Proses**: bukan_lead/lainnya + isyarat funnel_stage_lost (quotation belum dikirim, FU belum sesuai cycle, perlu eskalasi).

Mapping bersifat **pendekatan** (turunan dari field AI yang ada, bukan klasifikasi A/B/C/D native).

## Endpoint — `GET /api/supervisor-control/panel` (admin)

Active leads dalam scope (non-admin → milik sendiri). Per lead rakit (LATERAL: first_inbound_at,
last_outbound_at, last inbound msg, inbound_count, fu_count_today) + state (analyst fields) + jalankan
`lotusFollowup.followupState` & `supervisorPriority.classify`. Return:
```
{ priority_queue: [...P1..P3 sorted], groups: { sales_response_risk:[...], follow_up:[...], lead_stuck:{ A:[...],B:[...],C:[...],D:[...] } }, counts: {...} }
```
Tiap item: `lotus_id, cust_name, pic_name, lead_in_at(first_inbound), last_message, last_message_from,
awaiting_min, status, priority, groups, stuck_bucket, stuck_label, fu_status, fu_current_cycle,
fu_count_today, last_outbound_at, root_cause_tag, funnel_stage_lost, lead_status, controllability,
sales_handling, evidence_quote, analyst_report_generated_at`.

## Frontend

- `components/supervisor-control/LeadCard.jsx` — satu baris lead (kolom kontekstual per grup) + tombol aksi (Chat/Assign/Ack/Resolve/Minta FU) + toggle expand.
- `components/supervisor-control/GroupSection.jsx` — header grup + daftar `LeadCard` (untuk Grup 1/2/3; Grup 3 sub-header A/B/C/D).
- `components/supervisor-control/PriorityQueue.jsx` — daftar P1/P2/P3 dengan badge.
- `components/supervisor-control/DiagnosisPanel.jsx` (upgrade dari yang ada) — tampilkan **AI Diagnosis** (dari field tersimpan: lead_status, customer_intent, root_cause, sales_handling gaps), **Root Issue** (stuck_label/funnel_stage), **Suggested Action/Script** (fetch Tier B `analyst_summary_md` on-demand). Aksi termasuk **Revisi Analisa AI** (form: alasan benar + kategori issue + catatan sales + status akhir → action `revise_ai`).
- `pages/supervisor-control/index.js` — rewrite: fetch `/panel`, render PriorityQueue + 3 GroupSection, scope toggle, auto-refresh, aksi → `/lead/:id/action` lalu sembunyikan/refetch.

## Out of scope (fase berikutnya)

- Extend prompt AI ke taksonomi A/B/C/D native (sekarang mapping).
- Auto-learning dari `revise_ai`.
- Server-side hide ack'd dari `/panel` (MVP: client-side sembunyikan + log).
- Notifikasi "Minta FU" ke sales (MVP: log aksi).

## Testing

- `supervisorPriority.js` → unit test (priority tiers, groups, bucket mapping).
- `/panel` endpoint → supertest + mock dua DB.
- Frontend → `npm run build` + smoke.
