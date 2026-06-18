'use strict';
/**
 * penyebabTaxonomy.js
 * Ported verbatim from /home/krttpt/ads/lib/leadAnalysis.ts (ISSUE_TREE_DETAIL,
 * normalizeIssueTag, extractJson) and /home/krttpt/ads/lib/db.ts (theme-bucket
 * lexicons + bucket()). Single source of truth for the "penyebab tidak closing"
 * taxonomy used by the analisa-tidak-closing feature.
 *
 * CommonJS module — no TypeScript interfaces, logic identical to source.
 */

// ── Issue Tree (source: company spreadsheet) ─────────────────────────────────
// Three levels: issue → sub_issue (Keterangan Umum) → details (Keterangan Rinci).
const ISSUE_TREE_DETAIL = {
  Produk: {
    "Design tidak cocok": [
      "Design kurang menarik",
      "Design tidak sesuai preferensi customer",
      "Design tidak sesuai daerah pengiriman",
      "Pilihan design di website terbatas",
      "Contoh produk yang dikirim sales terlalu sedikit",
    ],
    "Produk tidak sesuai kebutuhan": [
      "Customer mencari model tertentu",
      "Produk kurang premium/simple/ramai",
      "Ukuran tidak sesuai",
      "Warna tidak sesuai",
      "Produk tidak sesuai ekspektasi customer",
    ],
    "Variasi produk kurang": [
      "Customer masih pilih produk",
      "Produk kurang bervariasi",
      "Customer minta contoh tambahan",
      "Customer belum menemukan produk yang cocok",
    ],
    "Produk tidak tersedia / harus PO": [
      "Produk harus PO",
      "Produk tidak tersedia di kota tujuan",
      "Stok supplier/mitra tidak tersedia",
      "Produk tertentu tidak bisa express",
    ],
  },
  Mitra: {
    "Estimasi pengiriman tidak cocok": [
      "Customer ingin under 3 jam",
      "Customer telat pesan",
      "Produk tidak bisa express",
      "Customer butuh kirim segera",
    ],
    "Area pengiriman bermasalah": [
      "Alamat beda pulau",
      "Alamat pelosok",
      "Tidak ada mitra terdekat",
      "Area tidak tercover",
      "Jarak mitra terlalu jauh",
    ],
    "Customer mencari lokasi terdekat": [
      "Customer menanyakan lokasi toko",
      "Ingin beli offline",
      "Ingin pickup",
      "Ingin COD",
      "Ingin melihat contoh asli produk",
    ],
    "Mitra tidak tersedia": [
      "Mitra penuh",
      "Produk tidak tersedia di mitra",
      "Mitra tidak bisa memenuhi SLA",
      "Kualitas/opsi mitra terbatas",
    ],
  },
  "Harga, Promo & Payment": {
    "Budget tidak cukup": [
      "Budget terlalu rendah",
      "Harga start terlalu tinggi",
      "Customer minta opsi lebih murah",
      "Harga tidak sesuai ekspektasi",
    ],
    "Dapat harga lebih murah": [
      "Kompetitor lebih murah",
      "Customer sudah dapat penawaran lain",
      "Customer merasa value belum terlihat",
      "Ongkir membuat total lebih mahal",
    ],
    "Keberatan ongkir": [
      "Ada biaya ongkir tambahan",
      "Tidak ada mitra terdekat",
      "Ongkir membuat total melewati budget",
    ],
    "Promo kurang menarik / belum ditawarkan": [
      "Sales tidak menawarkan promo",
      "Promo tidak cukup kuat",
      "Sales belum memberi urgency",
      "Customer belum merasa ada benefit order sekarang",
    ],
    "Kendala pembayaran": [
      "Minta tempo",
      "Minta DP 50%",
      "Minta DP di bawah 50%",
      "Ingin bayar setelah produk dikirim",
      "Sales belum menawarkan opsi DP jika memungkinkan",
    ],
  },
  Customer: {
    "Masih koordinasi dengan atasan/rekan": [
      "Menunggu approval atasan",
      "Koordinasi dengan rekan",
      "Double customer yang menghubungi Prestisa",
      "Keputusan belum final",
    ],
    "Masih survei / pesan lain waktu": [
      "Acara masih lama",
      "Masih survei harga",
      "Masih membandingkan vendor",
      "Belum urgent",
    ],
    "Sudah pesan di tempat lain / oleh rekan": [
      "Sudah order di vendor lain",
      "Sudah dipesankan rekan",
      "Double order internal",
      "Terlambat difollow up sehingga customer pindah",
    ],
    "Tidak jadi beli": [
      "Acara batal",
      "Penerima tidak berkenan",
      "Customer cancel tanpa alasan",
      "Kebutuhan sudah tidak jadi",
    ],
    "Customer belum memberikan keputusan": [
      "Sudah dibantu tapi belum konfirmasi",
      "Masih pikir-pikir",
      "Belum jawab setelah quotation",
      "Belum pilih produk final",
    ],
  },
  "Sales Handling & Follow Up": {
    "Telat response": [
      "Response pertama >1 menit",
      "Jeda balasan >10 menit",
      "Sales slow response",
      "Sales sedang istirahat",
      "Lead masuk terlalu banyak",
      "Kendala koneksi/system",
    ],
    "Follow up belum sesuai cycle": [
      "Belum di-follow up",
      "Follow up terlambat",
      "Follow up hanya sekali",
      "Tidak ada FU lanjutan",
      "Cycle 1/2/3 belum lengkap di hari yang sama",
    ],
    "Kualitas follow up kurang": [
      'Hanya tanya "jadi order?"',
      "Belum kirim katalog/contoh produk",
      "Belum jelaskan benefit",
      "Belum tawarkan alternatif",
      "Belum handling objection",
    ],
    "Discovery kebutuhan kurang": [
      "Belum tanya acara",
      "Belum tanya tanggal kirim",
      "Belum tanya budget",
      "Belum tanya style design",
      "Belum tanya lokasi detail",
    ],
    "Rekomendasi produk kurang tepat": [
      "Salah rekomendasi harga",
      "Salah rekomendasi design",
      "Tidak memberi opsi Good-Better-Best",
      "Tidak menyesuaikan produk dengan budget/kebutuhan",
    ],
    "Respon belum sesuai SOP": [
      "Sales tidak menjalankan SOP",
      "Jawaban kurang meyakinkan",
      "Alternatif jawaban case belum ada",
      "Sales tidak memberi solusi saat customer keberatan",
    ],
  },
  "Kualitas Lead": {
    "Lead tagline / low intent": [
      "Bubble chat customer dibawah 1",
      'Hanya kirim "harga?"',
      'Hanya kirim "ready?"',
      'Hanya kirim "lokasi?"',
      "Customer tidak menjelaskan kebutuhan",
      "Customer berhenti setelah 1x balas",
    ],
    "Lead random / tidak tertarget": [
      "Tanya hal di luar produk",
      "Salah nomor",
      "Tidak sesuai area/produk",
      "Bukan calon pembeli serius",
    ],
    "Customer sulit dihubungi": [
      "Chat belum dibaca",
      "Chat dibaca tapi tidak dibalas",
      "Centang satu",
      "Nomor sulit dihubungi",
      "Customer tidak respons setelah beberapa FU",
    ],
  },
};

// Derived: issue → allowed sub_issues
const ISSUE_TREE = Object.fromEntries(
  Object.entries(ISSUE_TREE_DETAIL).map(([issue, subs]) => [issue, Object.keys(subs)])
);

// Flat list of the 6 issue names
const ISSUES = Object.keys(ISSUE_TREE_DETAIL);

// No ISSUE_COLORS defined in ads source
const ISSUE_COLORS = {};

/**
 * Validate a raw {issue, sub_issue, rinci, detail} object against the taxonomy.
 * Returns null if issue or sub_issue is unknown.
 * rinci is snapped case-insensitively; "" if not found.
 *
 * Return shape: { issue, sub_issue, rinci, detail } | null
 */
function normalizeIssueTag(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const issue = String(raw.issue ?? '').trim();
  const subRaw = String(raw.sub_issue ?? '').trim();
  if (!ISSUE_TREE[issue]) return null;
  const sub = ISSUE_TREE[issue].find((s) => s.toLowerCase() === subRaw.toLowerCase());
  if (!sub) return null;
  const rinciList = ISSUE_TREE_DETAIL[issue]?.[sub] ?? [];
  const rinciRaw = String(raw.rinci ?? '').trim();
  const rinci = rinciList.find((r) => r.toLowerCase() === rinciRaw.toLowerCase()) ?? '';
  return { issue, sub_issue: sub, rinci, detail: String(raw.detail ?? '').trim() };
}

/**
 * Extract the first balanced top-level JSON object from a model response string,
 * then repair trailing commas. Returns the parsed object or null.
 *
 * Ported verbatim from ads/lib/leadAnalysis.ts extractJson(), but returns parsed
 * object (not raw string) so callers don't need a second JSON.parse().
 */
function extractJson(raw) {
  if (!raw) return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const cleaned = raw.slice(start, end + 1).replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch { return null; }
}

// ── Theme-bucket lexicons (from ads/lib/db.ts) ────────────────────────────────

const ROOT_CAUSE_THEMES = [
  ['Produk & ketersediaan', /produk|stok|ketersediaan|varian|model|desain|ukuran|katalog/i],
  ['Pengiriman & lokasi', /kirim|pengiriman|ongkir|ongkos|lokasi|jangkauan|area|jadwal|luar kota/i],
  ['Harga & budget', /harga|budget|mahal|biaya|anggaran|diskon|murah/i],
  ['Respon & follow-up', /respon|membalas|follow|tindak lanjut|lambat|terlambat|telat|menggantung/i],
  ['Skill & proaktif Sales', /proaktif|menggali|negosias|menawarkan|kualifikasi|handling|skill|kemampuan|edukas/i],
  ['SOP & sistem', /sop|standar|sistem|prosedur|playbook|template|panduan|tools|database/i],
  ['Kompetitor', /kompetitor|pesaing|tempat lain|beralih/i],
  ['Minat rendah / ghosting', /minat|ghost|menghilang|tidak tertarik|sekadar|survey|riset/i],
];

const SALES_STRENGTH_THEMES = [
  ['Respon cepat', /cepat|responsif|sigap|segera|menit/i],
  ['Penjelasan detail & jelas', /detail|jelas|lengkap|informatif|edukas|rinci/i],
  ['Ramah & sopan', /ramah|sopan|sabar|empati|hangat/i],
  ['Follow-up', /follow|tindak lanjut/i],
  ['Kirim visual / katalog', /foto|gambar|visual|katalog/i],
];

const SALES_PROBLEM_THEMES = [
  ['Handle harga lemah', /harga|budget|mahal|diskon|negosias/i],
  ['Tidak menawarkan alternatif', /alternatif|opsi|pilihan|bundle|paket/i],
  ['Tidak menggali kebutuhan', /menggali|kebutuhan|kualifikasi|probing|bertanya|menanyakan/i],
  ['Kurang proaktif', /proaktif|inisiatif|tidak menawarkan/i],
  ['Respon lambat / tak konfirmasi', /lambat|terlambat|telat|konfirmasi|tidak membalas|tidak merespon|tidak menanggapi/i],
  ['Follow-up lemah', /follow|tindak lanjut|menggantung/i],
  ['Kurang jelas / urgensi', /urgensi|tidak menjelaskan|kurang detail|tidak lengkap/i],
];

const ACTION_THEMES = [
  ['Follow-up proaktif', /follow|tindak lanjut|hubungi|menghubungi|reach|chat ulang/i],
  ['Tawarkan alternatif / promo', /alternatif|bundle|paket|promo|diskon|cicil|tawar|penawaran/i],
  ['Katalog & info pengiriman', /katalog|pengiriman|ongkir|lokasi|stok|ketersediaan|jadwal/i],
  ['Buat SOP / template', /sop|template|standar|playbook|skrip|prosedur|panduan/i],
  ['Konfirmasi & verifikasi', /konfirmasi|verifikasi|pembayaran|order/i],
  ['Coaching & training', /coaching|training|latih|pelatihan|evaluasi/i],
];

/**
 * Bucket free-text against a theme lexicon (first match wins).
 * @param {string} text
 * @param {[string, RegExp][]} themes
 * @returns {string}
 */
function bucket(text, themes) {
  const t = (text ?? '').trim();
  if (!t) return 'Lainnya';
  for (const [name, re] of themes) if (re.test(t)) return name;
  return 'Lainnya';
}

module.exports = {
  ISSUE_TREE_DETAIL,
  ISSUE_TREE,
  ISSUES,
  ISSUE_COLORS,
  normalizeIssueTag,
  extractJson,
  ROOT_CAUSE_THEMES,
  SALES_STRENGTH_THEMES,
  SALES_PROBLEM_THEMES,
  ACTION_THEMES,
  bucket,
};
