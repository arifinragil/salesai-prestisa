# Lotus Follow-Up Tracking (Sub-proyek B) — Design Spec

**Date:** 2026-06-17
**Project:** crm (salesai.prestisa.net)
**Status:** Approved design — ready for writing-plans
**Depends on:** Sub-proyek A (Kanban 7-tab) — sudah live.

## Goal

Lacak apakah sales sudah follow-up tiap lead Lotus sesuai cadence **H+1 / H+3 / H+5**,
tampilkan banner "X FU overdue — kerjakan sekarang!" yang akurat, dan beri filter "FU
Overdue" sebagai antrian tugas. Ini **pelacak tugas untuk sales** — sistem TIDAK mengirim
pesan otomatis.

## Decisions (locked)

- **Sifat:** task tracker (bukan auto-send). Sales follow up manual; sistem hanya melacak.
- **Anchor cadence:** `first_inbound_at` (kontak pertama customer). Due = anchor + {1, 3, 5} hari.
- **"FU selesai":** auto-detect dari `last_outbound_at` (pesan keluar dari sales). Tanpa tombol manual.
- **Scope:** semua lead `status='active'` (belum closed/spam/closing).
- **Arsitektur:** computed on-the-fly (tanpa tabel/cron/migrasi). Hanya butuh `first_inbound_at`
  + `last_outbound_at` per lead.

## Architecture

### Modul murni — `backend/services/lotusFollowup.js`
- `FU_CYCLES = [1, 3, 5]` (hari; H+1/H+3/H+5). `FU_CAP_DAYS = 7` (lewat ini → expired /
  urusan data-pending). Konstanta, mudah di-tune.
- `followupState({ first_inbound_at, last_outbound_at }, now)` →
  `{ in_fu, current_cycle (0–3), status, next_due_at, overdue_since }`.
- **Logika:**
  - Tanpa `first_inbound_at` → `{ status:'fresh', current_cycle:0, in_fu:false }`.
  - `dues = FU_CYCLES.map(d => anchor + d hari)`; `cap = anchor + FU_CAP_DAYS hari`.
  - `current_cycle` = jumlah `due <= now` (0–3); `next_due_at` = due pertama yang `> now`.
  - `current_cycle === 0` → `status:'fresh'` (belum H+1), `next_due_at = dues[0]`.
  - else: `lastDue = dues[current_cycle-1]`; `done = last_outbound_at && last_outbound_at >= lastDue`.
    - `now > cap && !done` → `status:'expired'`.
    - `done && current_cycle === 3` → `status:'done'`.
    - `done` → `status:'pending'` (cycle ini sudah di-FU, menunggu cycle berikut).
    - else → `status:'overdue'`, `overdue_since = lastDue`.
- Tanpa DB → unit-tested penuh. Modul terpisah dari `lotusTabs.js`.

### Backend — `backend/routes/lotusInbox.js`
1. Sediakan `last_outbound_at` per lead: tambah LATERAL `MAX(received_at) WHERE direction='outbound'`
   pada query `/contacts` dan `/tab-counts` (mirror lateral `lcs` yang sudah ada). Ekspos
   `last_outbound_at` di item shape.
2. Tambah filter tab `fu_overdue` di `/contacts`: lolos bila
   `followupState(item, now).status === 'overdue'`.
3. Tambah hitungan FU ke respons `/tab-counts`: `counts.fu_overdue` (status overdue) dan
   `counts.fu_pending` (status fresh atau pending — FU mendatang). Dipakai banner.

### Frontend
- `TodayTasksCard.jsx`: ganti banner placeholder "belum direspons" menjadi
  **"{fu_overdue} FU overdue — kerjakan sekarang!"** (pakai `counts.fu_overdue`); subteks
  "{fu_pending} FU pending (H+1/H+3/H+5)". Tombol "Buka Tugas" → `onPick('fu_overdue')`.
  Tetap fallback: bila `fu_overdue===0`, tampilkan banner urgent lama (atau sembunyikan).
- `TabStrip.jsx`: tambah tab `fu_overdue` (label "🔔 FU Overdue") agar bisa navigasi balik.
- Halaman `lotus-inbox/index.js`: tidak ada perubahan struktural — `fu_overdue` mengikuti
  mekanisme `tab` yang sudah ada (sudah jadi bagian `params`/SWR key).

## Cadence semantics (didokumentasikan)

Model cadence: tiap window cycle butuh ≥1 sentuhan sales. "overdue" berarti cycle berjalan
sudah jatuh tempo dan **belum ada pesan keluar sejak due cycle itu** (`last_outbound_at <
lastDue`). Konsekuensi sadar: bila sales menyentuh tepat sebelum due berikutnya, lead bisa
jadi 'overdue' lagi saat due berikut lewat — itu memang maksudnya (jaga ritme FU). Snooze/skip
FU manual = fase berikutnya (butuh tabel kecil), di luar scope B.

## Out of scope (Sub-proyek B)

- Auto-kirim pesan FU (diputuskan: task tracker saja).
- Tabel/worker/cron, snooze/skip FU manual, histori FU (computed-only).
- Halaman `/data-pending` untuk lead `expired` (>H+7) — disebut, tapi di luar scope.
- Template pesan FU per-cycle.

## Testing strategy

- `lotusFollowup.js` → unit test murni (Jest): tiap status (fresh/overdue/pending/done/expired),
  boundary tiap cycle & cap.
- Endpoint `fu_overdue` filter + `/tab-counts` fu counts → supertest + mock dua DB (lanjutan
  `lotusKanban.test.js`).
- Frontend → `npm run build` + smoke test manual banner & filter.
