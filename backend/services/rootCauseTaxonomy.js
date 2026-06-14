// Shared taxonomy for 5why root cause tagging.
// IMPORTANT: keep this file in sync with /home/krttpt/konsumen/backend/services/rootCauseTaxonomy.js

const TAXONOMY = [
  { key: 'harga_terlalu_mahal',   label: 'Harga Terlalu Mahal',   desc: 'protes harga / mahal vs kompetitor' },
  { key: 'barang_tidak_tersedia', label: 'Barang Tidak Tersedia', desc: 'out-of-stock' },
  { key: 'respon_lambat',         label: 'Respon Lambat',         desc: 'sales balas terlalu lama' },
  { key: 'info_produk_kurang',    label: 'Info Produk Kurang',    desc: 'gap info spek/material' },
  { key: 'ekspektasi_design',     label: 'Ekspektasi Design',     desc: 'design tidak sesuai' },
  { key: 'area_pengiriman',       label: 'Area Pengiriman',       desc: 'area / ongkir' },
  { key: 'timing_pengiriman',     label: 'Timing Pengiriman',     desc: 'H-1/sameday tidak bisa' },
  { key: 'kompetitor',            label: 'Pilih Kompetitor',      desc: 'explicit pilih toko lain' },
  { key: 'ragu_kredibilitas',     label: 'Ragu Kredibilitas',     desc: 'ragu pre-order' },
  { key: 'window_shopping',       label: 'Window Shopping',       desc: 'tanya iseng' },
  { key: 'lainnya',               label: 'Lainnya',               desc: 'fallback' },
];

const KEYS = TAXONOMY.map(t => t.key);
const LABELS = Object.fromEntries(TAXONOMY.map(t => [t.key, t.label]));

function isValidKey(k) { return KEYS.includes(k); }

function promptInstruction() {
  return [
    'Setelah section A–D, output 1 baris JSON di paling akhir dengan format:',
    '{"root_cause_tag":"<one_of_taxonomy>","confidence":0.0-1.0}',
    '',
    'Taxonomy yang valid (pilih persis 1):',
    ...TAXONOMY.map(t => `- ${t.key.padEnd(24)} (${t.desc})`),
    '',
    'Aturan:',
    '- Pakai "lainnya" + confidence rendah kalau tidak yakin.',
    '- Kalau percakapan ternyata sudah closing/berhasil, tag tetap diisi tapi confidence boleh 0.0.',
    '- Output JSON HARUS di baris terakhir, tidak boleh ada teks setelahnya, tidak di dalam code block.',
  ].join('\n');
}

module.exports = { TAXONOMY, KEYS, LABELS, isValidKey, promptInstruction };
