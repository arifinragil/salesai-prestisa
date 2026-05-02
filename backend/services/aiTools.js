const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const waClient = require('./waClient');
const sqlQueries = require('./sqlQueries');
const { getFaqTopic, listFaqTopics } = require('./aiKnowledge');

const PRODUCT_IMAGE_BASE = process.env.PRODUCT_IMAGE_BASE || 'https://prestisa.net';

function fullImageUrl(image) {
  if (!image) return null;
  const s = String(image).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  if (s.startsWith('/')) return PRODUCT_IMAGE_BASE + s;
  return PRODUCT_IMAGE_BASE + '/' + s;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const JABODETABEK = new Set([
  'jakarta', 'jakarta pusat', 'jakarta utara', 'jakarta selatan',
  'jakarta barat', 'jakarta timur', 'bogor', 'depok', 'tangerang',
  'tangerang selatan', 'bekasi',
]);

function normCity(s) { return String(s || '').trim().toLowerCase(); }

function clampInt(v, def, max) {
  const n = parseInt(v);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

// ── Declarations (Anthropic tool input_schema) ───────────────────────────────

const declarations = [
  {
    name: 'search_products',
    description: 'Cari produk dari katalog Prestisa. Filter optional: category, city (kota tujuan), budget_min/budget_max (rupiah, integer), query (free-text), limit (max 10, default 5). Return diurutkan top-seller dulu (item_sold DESC) lalu rating. WAJIB pakai tool ini sebelum menyebut harga atau menawarkan produk.',
    input_schema: {
      type: 'object',
      properties: {
        category:   { type: 'string', description: 'Nama kategori (mis. "Papan Sukacita", "Bouquet").' },
        city:       { type: 'string', description: 'Kota tujuan kirim.' },
        budget_min: { type: 'integer', description: 'Budget minimum dalam rupiah.' },
        budget_max: { type: 'integer', description: 'Budget maksimum dalam rupiah.' },
        query:      { type: 'string', description: 'Kata kunci nama produk.' },
        limit:      { type: 'integer', description: 'Jumlah produk yang dikembalikan (default 5, max 10).' },
      },
    },
  },
  {
    name: 'list_categories',
    description: 'Daftar kategori produk yang tersedia di kota tertentu, dengan jumlah produk per kategori. Pakai saat customer tanya "ada produk apa aja di kotaku?".',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Kota tujuan.' },
      },
      required: ['city'],
    },
  },
  {
    name: 'get_shipping_info',
    description: 'Cek apakah kota tujuan tercover dan ongkir berapa. Jabodetabek free, area lain Rp50.000. ETA 3-6 jam setelah pembayaran terkonfirmasi.',
    input_schema: {
      type: 'object',
      properties: {
        destination_city: { type: 'string', description: 'Kota tujuan pengiriman.' },
      },
      required: ['destination_city'],
    },
  },
  {
    name: 'get_active_promos',
    description: 'Cek promo yang sedang aktif. Filter optional category dan city. Return list promo dengan code, description, discount_pct/discount_amount, ends_at. Kalau kosong, jangan janjikan diskon.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        city:     { type: 'string' },
      },
    },
  },
  {
    name: 'get_faq',
    description: 'Ambil teks FAQ. Pakai topic snake_case (mis: payment, refund_policy, cancel_policy, hours, lead_time, area_coverage, shipping_fee, product_type, how_to_order, invoice, about). Daftar lengkap dimanage operator di /knowledge.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'kb_search',
    description: 'Cari KB topic berdasarkan makna pertanyaan customer (semantic search), bukan slug. Pakai jika pertanyaan customer tidak match topic slug yang ada di get_faq. Return top 3 kandidat dengan body lengkap. Pakai ini SEBELUM memutuskan handover karena "tidak tahu".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Pertanyaan customer apa adanya (bahasa natural).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_customer_orders',
    description: 'Daftar order terbaru milik customer ini. Customer_id auto-scoped, JANGAN minta dari user. Return max 20.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Jumlah max (default 5, max 20).' },
      },
    },
  },
  {
    name: 'get_order_status',
    description: 'Detail status 1 order (header, items dengan PO status, ETA). Pakai setelah find_customer_orders memberi order_id. Customer_id auto-scoped.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'ID internal order.' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'track_order',
    description: 'Cek status pengiriman / progress order berdasarkan NOMOR ORDER yang disebut customer (PO number, order number, atau order_id digit). Pakai untuk pertanyaan tipe "kapan sampai?", "PO 12345 sudah dikirim belum?", "pesanan saya sudah jalan?". Tidak perlu customer_id — bisa dipakai walau customer belum login. Return: status order, status PO per item (in_progress / shipped / delivered), tracking number, ekspedisi, scheduled date, dan link bukti kirim kalau ada.',
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'string', description: 'Nomor order yang disebut customer. Boleh angka saja (mis. "12345") atau format lengkap (mis. "ORD-12345").' },
      },
      required: ['order_number'],
    },
  },
  {
    name: 'recommend_products',
    description: 'Kirim 1-3 produk rekomendasi sebagai foto + caption (nama, harga) langsung ke chat customer via WhatsApp. Pakai SETELAH search_products dapat produk yang cocok dan kamu mau pamerkan ke customer dengan visual. Setelah pakai tool ini, lanjutkan reply text seperti biasa (mis. "Itu beberapa pilihannya Kak, mau yang mana?"). JANGAN kirim URL gambar di text reply — biarkan tool ini yang ngirim.',
    input_schema: {
      type: 'object',
      properties: {
        product_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'ID produk dari hasil search_products (max 3 sekaligus, pilih yang paling relevan).',
        },
      },
      required: ['product_ids'],
    },
  },
  {
    name: 'run_named_query',
    description: 'Jalanin SQL query yang sudah di-pre-define admin (whitelisted, read-only) untuk dapat data yang gak ter-cover tools lain. Contoh: "top_seller_per_kota". Cek list query yang tersedia + paramsnya via /api/admin/sql-queries. Tool ini SAFE — admin yang nentuin SQL-nya, AI cuma pilih nama + isi param. Output: rows array (capped per query). Pakai untuk query data spesifik yang admin sudah set.',
    input_schema: {
      type: 'object',
      properties: {
        query_name: { type: 'string', description: 'Nama query yang sudah pre-defined admin (snake_case).' },
        params: { type: 'object', description: 'Object key-value sesuai params yang query butuhkan.' },
      },
      required: ['query_name'],
    },
  },
  {
    name: 'request_handover',
    description: 'Eskalasi ke operator manusia. Pakai untuk: complaint, refund, cancel, pricing-custom, low-confidence, atau saat customer minta orang. Setelah ini AI pause 24 jam di percakapan ini.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['complaint', 'refund', 'cancel', 'custom_price', 'explicit_request_human', 'low_confidence', 'tool_error', 'other'] },
        summary: { type: 'string', description: 'Ringkasan singkat untuk operator (1-2 kalimat).' },
      },
      required: ['reason', 'summary'],
    },
  },
  {
    name: 'build_order_form_url',
    description: 'Bangun URL form order prefilled dengan data customer. Pakai ini sebagai langkah closing — link akan dibuka customer untuk verifikasi & bayar.',
    input_schema: {
      type: 'object',
      properties: {
        product_type: { type: 'string', enum: ['papan', 'bouquet', 'parsel', 'cake'] },
        prefill: {
          type: 'object',
          description: 'Data prefilled: name, city, recipient_address, recipient_name, card_message, sender_name, recipient_wa.',
          properties: {
            name:              { type: 'string' },
            city:              { type: 'string' },
            recipient_address: { type: 'string' },
            recipient_name:    { type: 'string' },
            card_message:      { type: 'string' },
            sender_name:       { type: 'string' },
            recipient_wa:      { type: 'string' },
          },
        },
      },
      required: ['product_type'],
    },
  },
];

// ── Executors ────────────────────────────────────────────────────────────────

// Normalisasi vocabulary Indonesian ↔ English untuk match category DB.
const CATEGORY_SYNONYMS = {
  'sukacita': 'congratulations', 'suka cita': 'congratulations', 'selamat': 'congratulations',
  'duka': 'dukacita', 'duka cita': 'dukacita', 'belasungkawa': 'dukacita',
  'pernikahan': 'wedding', 'nikah': 'wedding', 'menikah': 'wedding',
  'kue': 'cake', 'tart': 'cake', 'mawar': 'rose',
  'rangkaian': 'bouquet', 'buket': 'bouquet',
  'hampers': 'parsel', 'paket': 'parsel',
};

function normalizeCategoryTokens(category) {
  let s = String(category || '').toLowerCase().trim();
  const keys = Object.keys(CATEGORY_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const k of keys) if (s.includes(k)) s = s.replace(new RegExp(k, 'g'), CATEGORY_SYNONYMS[k]);
  return s.split(/\s+/).filter(Boolean);
}

// Product code prefix mapping — paling reliable filter kalau intent jelas.
// Format: digit 1-2 = jenis, digit 3-4 = sub-kategori.
// Returns array of code prefixes yang harus match (OR-joined dengan category text match).
function inferCodePrefixes(category, productType) {
  const s = String(category || '').toLowerCase();
  const t = String(productType || '').toLowerCase();
  const prefixes = [];

  // Jenis (2 digit pertama)
  let jenisCode = null;
  if (t === 'papan' || /papan/.test(s)) jenisCode = 'BP';
  else if (t === 'bouquet' || /bouquet|buket|rangkaian/.test(s)) jenisCode = 'BQ';
  else if (/bunga meja|standing/.test(s)) jenisCode = 'BM';
  else if (t === 'cake' || /kue|cake|tart/.test(s)) jenisCode = 'CK';
  else if (t === 'parsel' || /parsel|hampers|paket/.test(s)) jenisCode = 'P';

  // Sub-kategori (digit 3-4):
  // - Duka cita = sad/belasungkawa → BPDC
  // - Suka cita = happy. Default ke BPC- (congratulations); kalau ada konteks
  //   wedding/pernikahan, override ke BPW-
  // Wedding selalu lebih spesifik, dicek dulu.
  let subCode = null;
  if (/wedding|pernikahan|nikah|menikah|akad|resepsi/.test(s)) subCode = 'W-';
  else if (/duka|belasungkawa|kondolensi/.test(s)) subCode = 'DC';
  else if (/sukacita|suka cita|selamat|congratulations|congrat|opening|grand opening|ucapan/.test(s)) subCode = 'C-';
  else if (/kertas/.test(s)) subCode = 'KS';
  else if (/kayu/.test(s)) subCode = 'KY';

  if (jenisCode && subCode) {
    prefixes.push(jenisCode + subCode);
  } else if (jenisCode) {
    prefixes.push(jenisCode);
  }
  return prefixes;
}

async function search_products({ args }) {
  const limit = clampInt(args.limit, 5, 10);

  function buildSql(useCity) {
    const where = ['p.deleted_at IS NULL', 'p.price > 0'];
    const params = [];
    if (args.category) {
      // Strategi 1: product_code prefix (paling reliable jika intent jelas)
      const prefixes = inferCodePrefixes(args.category, args.product_type);
      // Strategi 2: text match category/name dengan synonym normalization
      const tokens = normalizeCategoryTokens(args.category);
      const textConds = [];
      for (const tok of tokens) {
        textConds.push(`(LOWER(c.name) LIKE ? OR LOWER(p.name) LIKE ?)`);
        params.push(`%${tok}%`, `%${tok}%`);
      }
      if (prefixes.length) {
        const codeConds = prefixes.map(() => `p.product_code LIKE ?`);
        prefixes.forEach((pre) => params.push(`${pre}%`));
        // OR antara: (text match all tokens) atau (code prefix match)
        if (textConds.length) {
          where.push(`((${textConds.join(' AND ')}) OR (${codeConds.join(' OR ')}))`);
        } else {
          where.push(`(${codeConds.join(' OR ')})`);
        }
      } else if (textConds.length) {
        where.push(...textConds);
      }
    }
    if (useCity && args.city) {
      params.push(`%${args.city}%`);
      where.push(`g_city.name LIKE ?`);
    }
    if (args.budget_min) { params.push(parseInt(args.budget_min)); where.push(`p.price >= ?`); }
    if (args.budget_max) { params.push(parseInt(args.budget_max)); where.push(`p.price <= ?`); }
    if (args.query) {
      const tokens = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
      for (const tok of tokens) { params.push(`%${tok}%`); where.push(`LOWER(p.name) LIKE ?`); }
    }
    const sql = `
      SELECT p.id, p.product_code, p.name, COALESCE(c.name, '?') AS category,
             p.price, p.image AS image_url, p.description,
             g_city.name AS city,
             COALESCE(s.total_penjualan, 0) AS total_penjualan
      FROM products p
      LEFT JOIN product_category_new c ON c.id = p.category_id
      LEFT JOIN geo g_city ON g_city.id = p.city
      LEFT JOIN (
        SELECT order_items.product_id, COUNT(order_items.product_code) AS total_penjualan
        FROM order_items
        INNER JOIN purchase_order ON order_items.id = purchase_order.pr_id
        WHERE order_items.bought > 0 AND order_items.deleted_at IS NULL AND purchase_order.deleted_at IS NULL
        GROUP BY order_items.product_id
      ) s ON s.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY total_penjualan DESC, p.id DESC
      LIMIT ${limit}`;
    return { sql, params };
  }

  let { sql, params } = buildSql(true);
  let [rows] = await mysql.query(sql, params);
  let cityFallback = false;
  // Soft fallback: city is a delivery preference, catalog might not be tagged
  // for the exact city. Retry without city to surface nearest matches.
  if (!rows.length && args.city) {
    ({ sql, params } = buildSql(false));
    [rows] = await mysql.query(sql, params);
    cityFallback = rows.length > 0;
  }
  if (!rows.length) {
    return { count: 0, products: [], note: 'Tidak ditemukan produk yang cocok dengan filter ini.' };
  }
  return {
    count: rows.length,
    city_fallback: cityFallback,
    note: cityFallback
      ? `Tidak ada produk yang spesifik di-tag untuk kota "${args.city}", ini hasil tanpa filter kota — Prestisa kirim ke seluruh Indonesia, jadi produk ini umumnya tetap bisa dikirim ke ${args.city}.`
      : undefined,
    products: rows.map((r) => ({
      ...r,
      description: r.description ? String(r.description).replace(/<[^>]+>/g, '').slice(0, 200) : null,
    })),
  };
}

async function list_categories({ args }) {
  const city = String(args.city || '').trim();
  if (!city) return { error: 'city wajib diisi' };
  const [rows] = await mysql.query(
    `SELECT c.id AS category_id, c.name, COUNT(p.id) AS count
     FROM product_category_new c
     LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL AND p.price > 0
     LEFT JOIN geo g_city ON g_city.id = p.city
     WHERE c.deleted_at IS NULL AND g_city.name LIKE ?
     GROUP BY c.id, c.name
     HAVING count > 0
     ORDER BY count DESC
     LIMIT 30`,
    [`%${city}%`]
  );
  return { city, count: rows.length, categories: rows };
}

async function get_shipping_info({ args }) {
  const city = String(args.destination_city || '').trim();
  if (!city) return { error: 'destination_city wajib diisi' };
  const isJabodetabek = JABODETABEK.has(normCity(city));
  let available = isJabodetabek;
  if (!isJabodetabek) {
    try {
      // Use geo table to check if Prestisa stocks anything in this city.
      const [rows] = await mysql.query(
        `SELECT 1 FROM products p JOIN geo g ON g.id = p.city
         WHERE g.name LIKE ? AND p.deleted_at IS NULL AND p.price > 0 LIMIT 1`,
        [`%${city}%`]
      );
      available = rows.length > 0;
    } catch {
      available = false;
    }
  }
  return {
    available,
    fee: isJabodetabek ? 0 : 50000,
    eta_text: '3-6 jam setelah pembayaran terkonfirmasi',
    note: isJabodetabek
      ? 'Free ongkir Jabodetabek'
      : (available ? 'Ongkir flat Rp50.000 untuk luar Jabodetabek' : 'Kota ini belum tercover sistem'),
  };
}

async function get_active_promos({ args }) {
  const params = [];
  const where = ['active = TRUE', 'starts_at <= now()', 'ends_at > now()'];
  if (args.category) { params.push(args.category); where.push(`(product_category IS NULL OR product_category = $${params.length})`); }
  if (args.city) { params.push(args.city); where.push(`(city IS NULL OR city = $${params.length})`); }
  const { rows } = await pg.query(
    `SELECT code, description, discount_pct, discount_amount, ends_at
     FROM crm_promo_settings
     WHERE ${where.join(' AND ')}
     ORDER BY ends_at ASC
     LIMIT 10`,
    params
  );
  if (!rows.length) {
    return {
      count: 0,
      promos: [],
      note: 'Belum ada promo aktif. Sampaikan apa adanya, jangan janjikan diskon.',
    };
  }
  return { count: rows.length, promos: rows };
}

async function get_faq({ args }) {
  const topic = String(args.topic || '').toLowerCase();
  const text = await getFaqTopic(topic);
  if (!text) {
    const valid = await listFaqTopics();
    return { error: `topic "${topic}" tidak dikenal. Valid: ${valid.join(', ')}` };
  }
  return { topic, text };
}

async function kb_search({ args }) {
  const q = String(args.query || '').trim();
  if (!q) return { error: 'query required' };
  try {
    const rag = require('./aiKbRag');
    const hits = await rag.search(q, 3);
    if (!hits.length) return { hits: [], note: 'no relevant KB topic ≥0.4 cosine — handover OK kalau tetap tidak yakin' };
    return { hits: hits.map((h) => ({ topic: h.topic, score: Number(h.score.toFixed(3)), body: h.body })) };
  } catch (err) {
    return { error: err.message };
  }
}

async function build_order_form_url({ args, phone, conv }) {
  const type = String(args.product_type || '').toLowerCase();
  let base;
  if (type === 'papan') base = process.env.ORDER_FORM_PAPAN_URL;
  else if (['bouquet', 'parsel', 'cake'].includes(type)) base = process.env.ORDER_FORM_BUNGA_URL;
  else return { error: `product_type "${type}" tidak dikenal. Valid: papan, bouquet, parsel, cake.` };

  if (!base) return { error: 'ORDER_FORM_*_URL belum dikonfigurasi di .env' };

  const prefill = args.prefill || {};
  const params = new URLSearchParams();
  params.set('phone', phone || '');
  if (prefill.name)              params.set('name', prefill.name);
  if (prefill.city)              params.set('city', prefill.city);
  if (prefill.recipient_address) params.set('recipient_address', prefill.recipient_address);
  if (prefill.recipient_name)    params.set('recipient_name', prefill.recipient_name);
  if (prefill.card_message)      params.set('card_message', prefill.card_message);
  if (prefill.sender_name)       params.set('sender_name', prefill.sender_name);
  if (prefill.recipient_wa)      params.set('recipient_wa', prefill.recipient_wa);

  // #1 UTM tracking — embed conv reference so we can attribute conversions
  // back to AI conversations. Customer's filled order will land in MySQL with
  // utm_source=tiara and we can JOIN to conv via utm_ref.
  let utmRef = null;
  if (conv?.id) {
    utmRef = `t-${conv.id}-${Date.now().toString(36)}`;
    params.set('utm_source', 'tiara');
    params.set('utm_medium', 'whatsapp');
    params.set('utm_campaign', 'ai-agent');
    params.set('utm_content', utmRef);
    // Persist on conv for later attribution
    try {
      const pg = require('../db/postgres');
      await pg.query(
        `UPDATE crm_conversations
           SET last_order_url_sent_at = now(), last_order_url_ref = $2
         WHERE id = $1`,
        [conv.id, utmRef]
      );
      // #2 Schedule follow-up if no order in 2 hours
      await pg.query(
        `INSERT INTO crm_followups (conversation_id, kind, scheduled_for, body_template, context)
         VALUES ($1, 'order_url_pending', now() + interval '2 hours', $2, $3)
         ON CONFLICT DO NOTHING`,
        [
          conv.id,
          'Halo Kak 🌸 Tadi link order udah Tiara kirim, gimana? Ada yang bisa dibantu lagi atau langsung lanjut isi formnya? Kalau ada pertanyaan, kabarin ya.',
          JSON.stringify({ utm_ref: utmRef, product_type: type }),
        ]
      );
    } catch (err) { /* non-fatal */ }

    // Pipeline: order_url_sent → form_dikirim, set type
    try {
      const engine = require('./pipelineEngine');
      const pg = require('../db/postgres');
      const typeMap = { papan: 'papan', bouquet: 'bouquet', parsel: 'parsel', cake: 'cake' };
      const mapped = typeMap[type];
      if (mapped) await engine.setType(pg, conv.id, mapped);
      await engine.apply(pg, conv.id, { type: 'order_url_sent' }, {
        source: 'auto:order_url_sent',
        metadata: { product_type: type, ref: utmRef },
      });
    } catch (err) { /* non-fatal */ }
  }

  return { url: `${base}?${params.toString()}`, utm_ref: utmRef };
}

const VALID_HANDOVER_REASONS = new Set([
  'complaint', 'refund', 'cancel', 'custom_price',
  'explicit_request_human', 'low_confidence', 'tool_error', 'other',
]);

async function find_customer_orders({ args, customer_id }) {
  if (!customer_id) {
    return { count: 0, orders: [], note: 'Customer ini belum terhubung ke akun Prestisa. Tanya nomor order langsung atau handover.' };
  }
  const limit = clampInt(args.limit, 5, 20);
  const sql = `
    SELECT id AS order_id, order_number, total, status, created_at
    FROM \`order\`
    WHERE customer_id = ? AND deleted_at IS NULL
    ORDER BY id DESC
    LIMIT ${limit}`;
  const [rows] = await mysql.query(sql, [customer_id]);
  return { count: rows.length, orders: rows };
}

async function get_order_status({ args, customer_id }) {
  const orderId = parseInt(args.order_id);
  if (!orderId) return { error: 'order_id wajib diisi' };
  if (!customer_id) return { error: 'Customer ini belum terhubung ke akun Prestisa.' };

  const [orders] = await mysql.query(
    `SELECT id, order_number, status, total, created_at
     FROM \`order\`
     WHERE id = ? AND customer_id = ? AND deleted_at IS NULL LIMIT 1`,
    [orderId, customer_id]
  );
  if (!orders.length) return { error: `order_id ${orderId} tidak ditemukan untuk customer ini` };
  const order = orders[0];

  const [items] = await mysql.query(
    `SELECT oi.id, oi.product_name, oi.qty, oi.price, oi.status,
            po.status AS purchase_order_status
     FROM order_items oi
     LEFT JOIN purchase_order po ON po.id = oi.purchase_order_id
     WHERE oi.order_id = ? AND oi.deleted_at IS NULL
     LIMIT 30`,
    [orderId]
  );
  return {
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    total: order.total,
    created_at: order.created_at,
    items,
    eta_text: '3-6 jam setelah pembayaran terkonfirmasi (untuk item yang belum dikirim)',
  };
}

async function track_order({ args }) {
  const raw = String(args.order_number || '').trim();
  if (!raw) return { error: 'order_number wajib diisi' };
  const digits = raw.replace(/\D/g, '');
  const numericId = digits ? parseInt(digits) : null;

  // Find order by id OR order_number (no customer_id scoping — public lookup)
  const [orders] = await mysql.query(
    `SELECT id, order_number, status, payment_status, total, created_at
     FROM \`order\`
     WHERE deleted_at IS NULL AND (id = ? OR order_number = ?)
     LIMIT 1`,
    [numericId, raw]
  );
  if (!orders.length) {
    return { found: false, note: `Order "${raw}" tidak ditemukan. Pastikan nomor benar (cek email/WA bukti pesan), atau handover ke tim Prestisa.` };
  }
  const order = orders[0];

  // Per-item PO status (production / shipping)
  const [items] = await mysql.query(
    `SELECT oi.id AS item_id, oi.name AS product_name, oi.qty,
            oi.receiver_name, oi.date_time AS scheduled_at, oi.order_status AS item_status,
            po.status AS po_status, po.payment_status AS po_payment_status,
            po.shipping_expedition, po.tracking_number, po.shipped_date,
            po.delivery_receipt, po.courier_phone, po.notes
     FROM order_items oi
     LEFT JOIN purchase_order po ON po.pr_id = oi.id AND po.deleted_at IS NULL
     WHERE oi.order_id = ? AND oi.deleted_at IS NULL
     ORDER BY oi.id ASC LIMIT 30`,
    [order.id]
  );

  return {
    found: true,
    order: {
      id: order.id,
      order_number: order.order_number,
      status: order.status,
      payment_status: order.payment_status,
      total: order.total,
      created_at: order.created_at,
    },
    items: items.map((it) => ({
      product_name: String(it.product_name || '').slice(0, 80),
      qty: it.qty,
      receiver_name: it.receiver_name,
      scheduled_at: it.scheduled_at,
      item_status: it.item_status,
      po_status: it.po_status,
      po_payment_status: it.po_payment_status,
      shipping_expedition: it.shipping_expedition,
      tracking_number: it.tracking_number,
      shipped_date: it.shipped_date,
      has_delivery_proof: !!it.delivery_receipt,
      courier_phone: it.courier_phone,
    })),
    eta_default: '3-6 jam setelah pembayaran terkonfirmasi (kalau belum shipped)',
    note: 'Sebutkan status per item (kalau lebih dari 1) dengan ringkas. Kalau status janggal (belum bayar / refund / dispute), tawarkan handover ke tim.',
  };
}

async function run_named_query({ args }) {
  const name = String(args.query_name || '').trim();
  if (!name) return { error: 'query_name wajib diisi' };
  try {
    return await sqlQueries.run(name, args.params || {});
  } catch (err) {
    return { error: err.message };
  }
}

async function recommend_products({ args, conv }) {
  const ids = (Array.isArray(args.product_ids) ? args.product_ids : [])
    .slice(0, 3)
    .map((v) => parseInt(v))
    .filter(Number.isFinite);
  if (!ids.length) return { error: 'product_ids wajib diisi (1-3 integer)' };

  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await mysql.query(
    `SELECT id, name, price, image FROM products WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    ids
  );

  if (!rows.length) return { error: 'produk tidak ditemukan' };

  const results = [];
  for (const id of ids) {
    const p = rows.find((r) => r.id === id);
    if (!p) { results.push({ id, ok: false, reason: 'not_found' }); continue; }
    if (!p.image) { results.push({ id, ok: false, reason: 'no_image' }); continue; }

    const imageUrl = fullImageUrl(p.image);
    const caption = `*${p.name}*\nRp${Number(p.price || 0).toLocaleString('id-ID')}`;

    try {
      const sent = await waClient.sendImage({ phone: conv.phone, imageUrl, caption });
      // Log to crm_messages so operator inbox shows it too
      await pg.query(
        `INSERT INTO crm_messages
           (conversation_id, direction, sender_type, body, message_type, attachment_url, send_status, waha_message_id, ai_metadata)
         VALUES ($1, 'out', 'ai', $2, 'image', $3, 'sent', $4, $5)`,
        [conv.id, caption, imageUrl, sent.id || null, JSON.stringify({ tool: 'recommend_products', product_id: p.id })]
      );
      results.push({ id, ok: true, image_url: imageUrl });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  const sentCount = results.filter((r) => r.ok).length;
  return {
    sent_count: sentCount,
    results,
    note: sentCount > 0
      ? `${sentCount} produk terkirim sebagai foto. Lanjutkan reply text untuk konfirmasi pilihan.`
      : 'Tidak ada produk yang berhasil dikirim. Lanjut tanpa gambar.',
  };
}

// Same logic as aiAgent.HUMAN_REQUIRED_REASONS — kept in sync.
const HUMAN_REQUIRED = new Set([
  'complaint', 'refund', 'cancel', 'custom_price',
  'explicit_request_human', 'legal', 'angry', 'manual_takeover',
]);

async function request_handover({ args, conv }) {
  const reason = String(args.reason || '').toLowerCase();
  if (!VALID_HANDOVER_REASONS.has(reason)) {
    return { error: `reason "${reason}" tidak valid. Valid: ${Array.from(VALID_HANDOVER_REASONS).join(', ')}` };
  }
  const summary = String(args.summary || '').slice(0, 1000);
  const pauseHours = HUMAN_REQUIRED.has(reason) ? 24 : 0;

  const ins = await pg.query(
    `INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, $2, $3) RETURNING id`,
    [conv.id, reason, summary]
  );
  if (pauseHours > 0) {
    await pg.query(
      `UPDATE crm_conversations
         SET ai_paused_until = now() + ($2 || ' hours')::interval,
             handover_count = handover_count + 1,
             updated_at = now()
       WHERE id = $1`,
      [conv.id, String(pauseHours)]
    );
  } else {
    await pg.query(
      `UPDATE crm_conversations SET handover_count = handover_count + 1, updated_at = now() WHERE id = $1`,
      [conv.id]
    );
  }
  return { ok: true, handover_id: ins.rows[0].id, paused_for_hours: pauseHours };
}

const executors = {
  search_products,
  list_categories,
  get_shipping_info,
  get_active_promos,
  get_faq,
  kb_search,
  build_order_form_url,
  find_customer_orders,
  get_order_status,
  track_order,
  recommend_products,
  run_named_query,
  request_handover,
};

module.exports = { declarations, executors, clampInt };
