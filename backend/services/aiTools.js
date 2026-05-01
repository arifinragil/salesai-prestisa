const mysql = require('../db/mysql');
const pg = require('../db/postgres');
const { getFaqTopic, listFaqTopics } = require('./aiKnowledge');

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
    description: 'Cari produk dari katalog Prestisa. Filter optional: category (nama kategori), city (kota tujuan), budget_min/budget_max (rupiah, integer), query (free-text matching nama produk). Return max 5 produk dengan id, name, category, price, city, image_url, description. WAJIB pakai tool ini sebelum menyebut harga atau menawarkan produk.',
    input_schema: {
      type: 'object',
      properties: {
        category:   { type: 'string', description: 'Nama kategori (mis. "Papan Sukacita", "Bouquet").' },
        city:       { type: 'string', description: 'Kota tujuan kirim.' },
        budget_min: { type: 'integer', description: 'Budget minimum dalam rupiah.' },
        budget_max: { type: 'integer', description: 'Budget maksimum dalam rupiah.' },
        query:      { type: 'string', description: 'Kata kunci nama produk.' },
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
    description: `Ambil teks FAQ untuk topik tertentu. Topic enum: ${listFaqTopics().join(', ')}.`,
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: listFaqTopics() },
      },
      required: ['topic'],
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

async function search_products({ args }) {
  const limit = 5;
  const where = ['p.deleted_at IS NULL'];
  const params = [];

  if (args.category) {
    params.push(args.category, args.category);
    where.push(`(c.name = ? OR p.category_name LIKE CONCAT('%', ?, '%'))`);
  }
  if (args.city) {
    params.push(args.city);
    where.push(`(p.city = ? OR p.city IS NULL)`);
  }
  if (args.budget_min) {
    params.push(parseInt(args.budget_min));
    where.push(`p.price >= ?`);
  }
  if (args.budget_max) {
    params.push(parseInt(args.budget_max));
    where.push(`p.price <= ?`);
  }
  if (args.query) {
    params.push(`%${args.query}%`);
    where.push(`p.name LIKE ?`);
  }

  const sql = `
    SELECT p.id, p.name, COALESCE(c.name, p.category_name) AS category,
           p.price, p.city, p.image_url, p.description
    FROM products p
    LEFT JOIN product_category_new c ON c.id = p.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.id DESC
    LIMIT ${limit}`;
  const [rows] = await mysql.query(sql, params);
  if (!rows.length) {
    return { count: 0, products: [], note: 'Tidak ditemukan produk yang cocok dengan filter ini.' };
  }
  return { count: rows.length, products: rows };
}

async function list_categories({ args }) {
  const city = String(args.city || '').trim();
  if (!city) return { error: 'city wajib diisi' };
  const [rows] = await mysql.query(
    `SELECT c.id AS category_id, c.name, COUNT(p.id) AS count
     FROM product_category_new c
     LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
       AND (p.city = ? OR p.city IS NULL)
     GROUP BY c.id, c.name
     HAVING count > 0
     ORDER BY count DESC
     LIMIT 30`,
    [city]
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
      // The standalone `city` table does not exist in lavender_lavenderPOS;
      // use products.city as the served-cities source.
      const [rows] = await mysql.query(
        `SELECT 1 FROM products WHERE LOWER(city) = ? AND deleted_at IS NULL LIMIT 1`,
        [normCity(city)]
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

function get_faq({ args }) {
  const topic = String(args.topic || '').toLowerCase();
  const text = getFaqTopic(topic);
  if (!text) return { error: `topic "${topic}" tidak dikenal. Valid: ${listFaqTopics().join(', ')}` };
  return { topic, text };
}

function build_order_form_url({ args, phone }) {
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

  return { url: `${base}?${params.toString()}` };
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

async function request_handover({ args, conv }) {
  const reason = String(args.reason || '').toLowerCase();
  if (!VALID_HANDOVER_REASONS.has(reason)) {
    return { error: `reason "${reason}" tidak valid. Valid: ${Array.from(VALID_HANDOVER_REASONS).join(', ')}` };
  }
  const summary = String(args.summary || '').slice(0, 1000);

  const ins = await pg.query(
    `INSERT INTO crm_handovers (conversation_id, reason, detail) VALUES ($1, $2, $3) RETURNING id`,
    [conv.id, reason, summary]
  );
  await pg.query(
    `UPDATE crm_conversations
       SET ai_paused_until = now() + INTERVAL '24 hours',
           handover_count = handover_count + 1,
           updated_at = now()
     WHERE id = $1`,
    [conv.id]
  );
  return { ok: true, handover_id: ins.rows[0].id, paused_for_hours: 24 };
}

const executors = {
  search_products,
  list_categories,
  get_shipping_info,
  get_active_promos,
  get_faq,
  build_order_form_url,
  find_customer_orders,
  get_order_status,
  request_handover,
};

module.exports = { declarations, executors, clampInt };
