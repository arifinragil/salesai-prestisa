# Kanban Inbox — 7 Smart Tabs (Sub-proyek A) — Design Spec

**Date:** 2026-06-17
**Project:** crm (salesai.prestisa.net)
**Status:** Approved design — ready for writing-plans
**Reference:** `img/WhatsApp Image 2026-06-17 at 10.10.20.jpeg`

## Goal

Tambah tab-strip 7 smart-filter ke halaman `/lotus-inbox` yang sudah ada, plus kartu
"Tugas kamu hari ini" dan banner ringkas. Tiap tab adalah view operasional harian
(All / Urgent / Hot ASAP / Customer Baru / Tunggu Balas / Mau Closing / Tunggu Cust),
di-scope per user (sales lihat lead-nya sendiri, supervisor/admin lihat seluruh tim).

## Decomposition note

Ini Sub-proyek A. Sub-proyek B (Lotus Follow-Up tracking: tabel FU, siklus H+1/H+3/H+5,
scheduler, banner "FU overdue" akurat) adalah spec terpisah berikutnya. A tidak mengubah
skema DB — semua field sudah ada.

## Data reality (penting)

DUA database Postgres: `db/postgres.js` → `vonage_reports` (`crm_*`, termasuk
`crm_lotus_state`); `db/lotus.js` → `lotus_conversations` (`contacts`, `messages`). Tidak
bisa JOIN lintas-DB — endpoint `/api/lotus-inbox/contacts` sudah memakai pola dua-query +
merge (`getStateMap`).

Lotus TIDAK punya: `pipeline_stage`, `last_outcome`, handover terstruktur, `crm_followups`
(semua WAHA-only). Aturan tab di bawah sudah diadaptasi ke field Lotus nyata.

## Tab rules (final, adapted)

WIB = UTC+7. `waiting = now − last_message_at`. `last_message_from` dinormalisasi: dianggap
inbound jika diawali "in" (nilai bisa `'inbound'/'outbound'` atau `'in'/'out'` tergantung
sumber). Semua tab (kecuali Customer Baru overlay) mensyaratkan `status='active'`.

| Tab key | Label | Aturan |
|---|---|---|
| `all` | All | `status='active'` dalam scope |
| `urgent` | 🚨 Urgent | inbound terakhir & `waiting > 30 mnt` & tidak snoozed |
| `hot_asap` | 🔥 Hot ASAP | `lead_temperature` ~ 'hot' (case-insensitive) |
| `customer_baru` | 🆕 Customer Baru | `first_inbound_at ≥ awal-hari-ini-WIB` (overlay: dihitung walau cocok tab lain) |
| `tunggu_balas` | ⏰ Tunggu Balas | inbound terakhir & `30 mnt ≤ waiting ≤ 48 jam` & tidak snoozed |
| `mau_closing` | ✅ Mau Closing | `lead_score ≥ 60` **atau** `last_intent ∈ CLOSING_INTENTS` **atau** `root_cause_tag='sudah_closing'` |
| `tunggu_cust` | 🔁 Tunggu Cust | outbound terakhir & `1 jam ≤ sejak-last ≤ 24 jam` & tidak snoozed |

- Urgent (>30 mnt) adalah subset merah dari Tunggu Balas (sengaja overlap).
- Ambang (`30`, `48*60`, `60`, `1*60`, `24*60` menit; threshold score `60`) = konstanta
  modul, mudah di-tune.
- `CLOSING_INTENTS` = set nilai `last_intent` yang menandai niat order/bayar (nilai pasti
  diverifikasi saat implementasi terhadap data; default: `order_intent`, `order`, `payment`,
  `closing`, `checkout`). `lead_score` diasumsikan skala 0–100 (diverifikasi saat implementasi).

## Scoping per-user

- `req.staff.role === 'admin'` → lihat seluruh tim (semua lead). Boleh toggle ke "Saya".
- role lain → dipaksa scope ke `assigned_staff_id === req.staff.staff_id` (lead miliknya).
- Unassigned leads hanya tampil untuk admin (sales tidak melihat lead yang bukan miliknya).

## Architecture

### Modul murni — `backend/services/lotusTabs.js`
- `tabsForItem(item, now)` → array tab key (subset dari urgent/hot_asap/customer_baru/
  tunggu_balas/mau_closing/tunggu_cust) yang dicocoki item. `all` tidak dimasukkan (semua
  active = all).
- `THRESHOLDS` (objek konstanta) + `CLOSING_INTENTS` (set).
- Helper internal: `startOfTodayWIB(now)`, `isInbound(last_message_from)`.
- Input `item` butuh field: `status, last_message_from, last_message_at, first_inbound_at,
  lead_temperature, lead_score, last_intent, root_cause_tag, snoozed_until`.
- Tanpa DB → unit-tested penuh.

### Backend — `backend/routes/lotusInbox.js`
1. Ekspos field state tambahan di item shape `GET /contacts` (sudah ada di `getStateMap`,
   tinggal di-passthrough): `first_inbound_at`, `first_response_at`, `lead_score`,
   `last_intent`, `handover_count`, `root_cause_tag`.
2. Param `?tab=<key>` → filter item via `tabsForItem(item, now).includes(tab)` (di JS,
   setelah merge — konsisten dgn filter scoping JS yang sudah ada).
3. Scoping by role (helper `applyScope(items, req)`): non-admin dipaksa ke lead sendiri.
4. Endpoint baru `GET /api/lotus-inbox/tab-counts` → `{ counts: { all, urgent, hot_asap,
   customer_baru, tunggu_balas, mau_closing, tunggu_cust } }` untuk badge + kartu tugas +
   banner. Memindai lead active dalam scope (tanpa paginasi, cap wajar) dan menghitung via
   `tabsForItem`.

### Frontend
- `frontend/src/components/lotus-inbox/TabStrip.jsx` — 7 tab horizontal-scroll + badge angka.
- `frontend/src/components/lotus-inbox/TodayTasksCard.jsx` — kartu "Tugas kamu hari ini"
  (Urgent / Customer Baru / Tunggu Balas) + banner "X lead belum direspons" (pakai count
  Urgent; placeholder sampai Sub-proyek B menyalakan banner FU).
- `frontend/src/pages/lotus-inbox/index.js` — state `tab`, wire `?tab=` ke fetch contacts,
  fetch `tab-counts` (refresh berkala), render TabStrip + TodayTasksCard, toggle scope
  (Tim/Saya) untuk admin.

## Out of scope (Sub-proyek A)

- Perubahan skema DB / migrasi (tidak ada).
- FU tracking, banner "FU overdue" akurat, siklus FU (→ Sub-proyek B).
- Drag-drop kolom Kanban (ini tab-strip filter, bukan board).
- Halaman `/data-pending` untuk lead ghost >24 jam (disebut di aturan, tapi di luar scope).

## Testing strategy

- `lotusTabs.js` → unit test murni (Jest), termasuk boundary WIB dan tiap ambang.
- Endpoint `tab` + `tab-counts` → supertest dengan `jest.mock` untuk `../db/lotus` &
  `../db/postgres`.
- Frontend → verifikasi `npm run build` + smoke test manual.
