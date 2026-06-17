# Native A/B/C/D Taxonomy + Auto-Learning — Design Spec

**Date:** 2026-06-17
**Project:** crm (salesai.prestisa.net)
**Status:** Approved — ready for writing-plans
**Builds on:** Supervisor Control 5-grup (panel sudah live).

## Goal

1. **Taksonomi A/B/C/D native:** analyst-report langsung mengklasifikasi lead "stuck" ke 4 grup
   (Customer/Sales/Offer/Proses) + sub-issue spesifik — bukan mapping pendekatan dari
   `root_cause_tag`. Dipakai di Grup 3 panel.
2. **Auto-learning dari Revisi:** koreksi supervisor (`revise_ai`) (a) langsung menimpa
   klasifikasi lead itu, dan (b) di-inject ke prompt Tier A sebagai contoh koreksi lapangan
   agar analisa berikutnya makin selaras.

Additive: TIDAK mengubah field Tier A yang ada (rendah risiko ke fitur analyst lain).

## Perubahan

### 1. Skema (migrasi 035)
`ALTER TABLE crm_lotus_state ADD COLUMN stuck_group text, ADD COLUMN stuck_issue text;`
(`stuck_group` ∈ customer|sales|offer|proses; `stuck_issue` = label sub-issue.)

### 2. `services/analystTaxonomy.js`
- Tambah enum `stuck_group: ['customer','sales','offer','proses']`.
- `validateTierAOutput`: tambah `stuck_group: validEnum('stuck_group', raw.stuck_group)` dan
  `stuck_issue: typeof raw.stuck_issue === 'string' ? raw.stuck_issue.slice(0,80) : null`.

### 3. `services/analystReport.js`
- `buildTierAUserPrompt({..., corrections})`: tambah blok instruksi `stuck_group`+`stuck_issue`
  dengan daftar sub-issue per grup (dari spek user):
  - **customer**: tanya harga · belum ada tanggal jelas · bandingkan vendor · belum balas setelah quotation · keberatan harga · menunggu approval · belum yakin desain/produk
  - **sales**: kurang gali kebutuhan · terlalu cepat kirim harga · belum jelaskan value · salah rekomendasi · belum opsi Good-Better-Best · belum urgency/promo · follow up pasif · tidak tangkap buying signal
  - **offer**: produk tidak sesuai · harga tidak masuk budget · desain kurang cocok · area/waktu kirim kendala · promo kurang menarik · tidak ada alternatif
  - **proses**: belum FU sesuai cycle · response time lama · quotation belum dikirim · bukti desain/foto belum dikirim · perlu eskalasi supervisor
  - `stuck_group=null` bila lead tidak stuck (mis. sudah closing).
- Tambah 2 field ke contoh JSON output.
- **Auto-learning:** kalau `corrections` (array `{from, to, reason}`) ada, sisipkan blok
  "KOREKSI SUPERVISOR DARI LAPANGAN (pelajari pola)" sebelum transkrip (maks 15 contoh).
- `runTierA({..., corrections})`: teruskan ke prompt builder.

### 4. Penyimpanan (2 writer)
- `cron_analyst_tier_a_prewarm.js`: INSERT/UPDATE tambah `stuck_group`, `stuck_issue`; **dan**
  ubah `findTargets` agar juga memilih lead yang `analyst_report_generated_at IS NOT NULL`
  tapi `stuck_group IS NULL` (backfill bertahap, cap 1000/run, sehingga tidak ada one-shot
  mahal). Sebelum jalan, ambil `corrections` (lihat #6) dan teruskan ke `runTierA`.
- Endpoint `POST /contacts/:id/analyst-report` (lotusInbox.js): simpan 2 field + teruskan
  `corrections` ke `runTierA`.

### 5. Panel (`routes/supervisorControl.js` `/panel`)
- `stuck = root_cause_tag || funnel_stage_lost || stuck_group`.
- Jika `s.stuck_group` ada → bucket = map(customer→A, sales→B, offer→C, proses→D),
  `stuck_label = s.stuck_issue || <label grup>`. Else fallback ke `classify` (mapping lama).

### 6. Auto-learning loop
- Helper `getRecentCorrections(limit=15)` (di supervisorControl atau service): 
  `SELECT corrected_root_cause, corrected_reason, note FROM crm_lead_supervisor_actions
   WHERE action='revise_ai' AND corrected_root_cause IS NOT NULL ORDER BY created_at DESC LIMIT $1`.
  → array `{ to: corrected_root_cause, reason: corrected_reason }`. Diteruskan ke runTierA oleh
  cron + endpoint.
- **Immediate override:** di handler `POST /lead/:id/action`, saat `action==='revise_ai'` &
  `corrected_root_cause`, langsung `UPDATE crm_lotus_state SET root_cause_tag=$corrected,
  stuck_group = <derive dari corrected via STUCK_GROUP_OF>, stuck_issue = COALESCE($corrected_reason, stuck_issue)
  WHERE lotus_id=$1`. Panel langsung mencerminkan koreksi.
  - `STUCK_GROUP_OF` map root_cause_tag → group (harga_terlalu_mahal/window_shopping/kompetitor/ragu_kredibilitas→customer; respon_lambat/info_produk_kurang→sales; barang_tidak_tersedia/ekspektasi_design/area_pengiriman/timing_pengiriman→offer; lainnya→proses).

## Out of scope
- Mengubah field Tier A lain / Tier B.
- Statistik/loop learning lebih canggih (mis. fine-tune). Sekarang few-shot injection + override.

## Testing
- `analystTaxonomy` validate stuck_group/stuck_issue → unit test.
- `buildTierAUserPrompt` menyertakan blok corrections saat diberi → unit test (string contains).
- `STUCK_GROUP_OF` mapping → unit test.
- Panel: native stuck_group dipakai → supertest (mock).
- Migrasi applied; cron + endpoint storage diverifikasi runtime.
