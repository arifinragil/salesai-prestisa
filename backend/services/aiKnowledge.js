// FAQ knowledge — sourced from DB (crm_kb_topics) with 60s in-process cache.
// Static FAQ kept as fallback if DB load fails or table is empty.
const pg = require('../db/postgres');

const STATIC_FAQ = {
  payment: `Pembayaran bisa via transfer bank (BCA / Mandiri / BRI / BNI), QRIS, atau Virtual Account.`,
  refund_policy: `Refund bisa diproses kalau order belum mulai diproduksi.`,
  cancel_policy: `Cancel bisa dilakukan sebelum produksi mulai.`,
  hours: `Prestisa beroperasi 24/7 untuk pemesanan online. Tim CS aktif jam 08.00-22.00 WIB.`,
  lead_time: `Lead time 3-6 jam setelah pembayaran terkonfirmasi.`,
  area_coverage: `Prestisa cover hampir semua kota di Indonesia.`,
  shipping_fee: `Free ongkir Jabodetabek. Area lain Rp50.000 flat.`,
  product_type: `Prestisa: papan bunga, bouquet, parsel, cake.`,
  how_to_order: `Kasih tahu jenis, kota tujuan, budget. Kami kirim pilihan + form order.`,
  invoice: `Invoice/faktur dikirim via email setelah pembayaran terkonfirmasi.`,
  about: `Prestisa adalah toko bunga online (papan, bouquet, parsel, cake) ke seluruh Indonesia.`,
};

const TTL_MS = 60_000;
let cache = null;
let cacheAt = 0;

async function loadFromDb() {
  try {
    const { rows } = await pg.query(
      `SELECT topic, body FROM crm_kb_topics WHERE enabled = TRUE`
    );
    if (!rows.length) return null;
    return Object.fromEntries(rows.map((r) => [r.topic, r.body]));
  } catch (err) {
    console.error('[aiKnowledge] DB load failed:', err.message);
    return null;
  }
}

async function getMap() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  cache = (await loadFromDb()) || STATIC_FAQ;
  cacheAt = Date.now();
  return cache;
}

async function listFaqTopics() {
  return Object.keys(await getMap());
}

async function getFaqTopic(topic) {
  if (!topic) return null;
  const map = await getMap();
  return map[String(topic).toLowerCase().trim()] || null;
}

function invalidateCache() { cache = null; cacheAt = 0; }

module.exports = { listFaqTopics, getFaqTopic, invalidateCache };
