'use strict';
// TDD for pure functions in penyebabAnalyze.js
// No network calls — analyzeLead is NOT tested here.

const { buildPenyebabPrompt, parseAnalysis } = require('../services/penyebabAnalyze');

// ── parseAnalysis ─────────────────────────────────────────────────────────────

const VALID_RAW = JSON.stringify({
  penyebab_tidak_closing: "Customer keberatan harga produk terlalu tinggi",
  ringkasan: "Customer menanyakan harga papan bunga, merasa mahal, tidak jadi order.",
  issue_tree: {
    issue: "Harga, Promo & Payment",
    sub_issue: "Budget tidak cukup",
    rinci: "Harga tidak sesuai ekspektasi",
    detail: "Customer bilang 'mahal banget kak, budget saya cuma 300rb'"
  },
  five_why: {
    why1: "Customer merasa harga terlalu tinggi",
    why2: "Sales tidak menawarkan opsi produk lebih murah",
    why3: "Sales tidak menjalankan Good-Better-Best framework",
    why4: "Tidak ada SOP rekomendasi produk berdasarkan budget",
    why5: "Belum ada playbook objection handling untuk keberatan harga",
    root_cause: "Sales tidak terlatih menangani keberatan harga dengan alternatif produk",
    corrective_action: "Buat SOP Good-Better-Best dan latih sales handling objection harga"
  },
  pov_customer: {
    kebutuhan_inti: "Papan bunga untuk duka cita",
    sentiment: "Kecewa",
    kepuasan_handling: "😞",
    urgency: "Tinggi",
    pain_point: "Harga tidak masuk budget",
    ekspektasi_tidak_terpenuhi: "Ekspektasi harga lebih terjangkau"
  },
  pov_sales: {
    good: ["Respon cepat — membalas dalam 1 menit"],
    problem: ["Tidak menawarkan alternatif — langsung ke produk termahal"]
  },
  action: {
    status_percakapan: "menunggu customer",
    risk_assessment: "churn (high) — customer sudah lihat kompetitor; potensi closing (low)",
    next_actions: [{ priority: "P1", action: "Tawarkan paket budget 300rb", deadline: "Hari ini" }],
    coaching_note: "Sales perlu latihan Good-Better-Best",
    pola_monitor: "Frekuensi keberatan harga per sales"
  }
});

test('parseAnalysis: valid JSON with known issue_tree returns mapped row + churn detected', () => {
  const row = parseAnalysis(VALID_RAW);
  expect(row).not.toBeNull();
  // taxonomy fields
  expect(row.issue).toBe('Harga, Promo & Payment');
  expect(row.sub_issue).toBe('Budget tidak cukup');
  expect(row.rinci).toBe('Harga tidak sesuai ekspektasi');
  // churn detection from risk_assessment containing 'churn'
  expect(row.churn).toBe(true);
  // penyebab_tidak_closing preserved
  expect(row.penyebab_tidak_closing).toBe('Customer keberatan harga produk terlalu tinggi');
  // analisa is full parsed object
  expect(row.analisa).toBeTruthy();
  expect(row.analisa.five_why).toBeDefined();
  expect(row.analisa.pov_customer).toBeDefined();
  expect(row.analisa.pov_sales).toBeDefined();
  expect(row.analisa.action).toBeDefined();
  // is_closing defaults false when not in JSON
  expect(row.is_closing).toBe(false);
});

test('parseAnalysis: unknown issue_tree returns issue=null but keeps penyebab + analisa', () => {
  const raw = JSON.stringify({
    penyebab_tidak_closing: "Alasan tidak diketahui",
    ringkasan: "Singkat.",
    issue_tree: {
      issue: "UNKNOWN ISSUE XYZ",
      sub_issue: "Apapun",
      rinci: "Detail tidak ada",
      detail: "Tidak ada bukti"
    },
    five_why: { why1: "a", why2: "b", why3: "c", why4: "d", why5: "e", root_cause: "r", corrective_action: "ca" },
    pov_customer: { kebutuhan_inti: "", sentiment: "", kepuasan_handling: "", urgency: "", pain_point: "", ekspektasi_tidak_terpenuhi: "" },
    pov_sales: { good: [], problem: [] },
    action: { status_percakapan: "", risk_assessment: "low risk", next_actions: [], coaching_note: "", pola_monitor: "" }
  });
  const row = parseAnalysis(raw);
  expect(row).not.toBeNull();
  expect(row.issue).toBeNull();
  expect(row.sub_issue).toBeNull();
  expect(row.rinci).toBeNull();
  // penyebab preserved
  expect(row.penyebab_tidak_closing).toBe('Alasan tidak diketahui');
  // analisa preserved
  expect(row.analisa).toBeTruthy();
  expect(row.analisa.five_why).toBeDefined();
  // churn false (risk_assessment has no 'churn')
  expect(row.churn).toBe(false);
});

test('parseAnalysis: returns null on empty string', () => {
  expect(parseAnalysis('')).toBeNull();
  expect(parseAnalysis(null)).toBeNull();
});

// ── buildPenyebabPrompt ───────────────────────────────────────────────────────

test('buildPenyebabPrompt: includes transcript text', () => {
  const transcript = 'Customer: halo kak\nSales (Budi): selamat datang';
  const prompt = buildPenyebabPrompt({ transcript, msgCount: 2 });
  expect(prompt).toContain(transcript);
});

test('buildPenyebabPrompt: includes at least one real issue name from taxonomy', () => {
  const prompt = buildPenyebabPrompt({ transcript: 'test', msgCount: 1 });
  expect(prompt).toMatch(/Produk/);
});

test('buildPenyebabPrompt: includes msgCount', () => {
  const prompt = buildPenyebabPrompt({ transcript: 'x', msgCount: 15 });
  expect(prompt).toContain('15');
});

test('buildPenyebabPrompt: includes penyebab_tidak_closing field name in instruction', () => {
  const prompt = buildPenyebabPrompt({ transcript: 'x', msgCount: 1 });
  expect(prompt).toMatch(/penyebab_tidak_closing/);
});
