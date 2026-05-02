const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const sqlQueries = require('./sqlQueries');

async function loadActivePrompt() {
  const { rows } = await pg.query(
    `SELECT name, prompt_text FROM crm_persona_prompts WHERE active = TRUE LIMIT 1`
  );
  if (!rows[0]) throw new Error('no active persona prompt — seed migration may not have run');
  return rows[0];
}

// A/B persona experiment. Returns { id, name, prompt_text, experimentVariant?: 'A'|'B' }.
// Pinned per-conversation: once a conv is bucketed (column experiment_variant set),
// it stays on the same variant for the whole conversation lifetime.
async function loadPromptForConversation(conv) {
  const expQ = await pg.query(
    `SELECT id, variant_a, variant_b, split_pct
     FROM crm_persona_experiments WHERE enabled = TRUE LIMIT 1`
  );
  if (!expQ.rows[0]) return loadActivePrompt();
  const exp = expQ.rows[0];
  let variant = conv.experiment_variant || null;
  if (!variant) {
    // Hash conv.id to a stable bucket — simple mod for evenness given large id space.
    const bucket = conv.id % 100;
    variant = bucket < exp.split_pct ? 'A' : 'B';
    await pg.query(
      `UPDATE crm_conversations SET experiment_variant = $2 WHERE id = $1`,
      [conv.id, variant]
    );
  }
  const personaId = variant === 'A' ? exp.variant_a : exp.variant_b;
  const { rows } = await pg.query(
    `SELECT id, name, prompt_text FROM crm_persona_prompts WHERE id = $1`,
    [personaId]
  );
  if (!rows[0]) return loadActivePrompt();
  return { ...rows[0], experimentVariant: variant };
}

async function fetchRecentOrders(customer_id, limit = 3) {
  if (!customer_id) return [];
  try {
    const [rows] = await mysql.query(
      `SELECT id AS order_id, order_number, total, status, created_at
       FROM \`order\`
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY id DESC LIMIT ?`,
      [customer_id, limit]
    );
    return rows;
  } catch (err) {
    console.error('[aiPersona] fetchRecentOrders failed:', err.message);
    return [];
  }
}

function summarizeOrders(orders) {
  if (!orders.length) return 'Tidak ada order historis.';
  return orders.map((o) => {
    const date = o.created_at ? new Date(o.created_at).toISOString().slice(0, 10) : '?';
    return `- ${o.order_number || o.order_id} | Rp${o.total ?? '?'} | ${o.status ?? '?'} | ${date}`;
  }).join('\n');
}

async function listNamedQueriesForPrompt() {
  try {
    const queries = await sqlQueries.listEnabled();
    if (!queries.length) return '';
    const lines = queries.map((q) => {
      const params = (q.params || [])
        .map((p) => `${p.name}${p.required ? '*' : ''}:${p.type || 'string'}`)
        .join(', ');
      return `  - ${q.name}(${params}) → ${q.description}`;
    });
    return `\n\n=== NAMED SQL QUERIES (pakai via run_named_query tool) ===\n${lines.join('\n')}\nNote: param dengan * = required.\n=== END QUERIES ===`;
  } catch {
    return '';
  }
}

// #6 Tag-aware tone hints: append nuance based on currently-attached tags.
// Match by lowercased tag name (substring) — tag names are operator-defined.
const TAG_TONE_RULES = [
  { match: /\bvip\b/, hint: 'Customer ini VIP (loyal, sering order). Pakai tone formal-hangat, sapaan lengkap, hindari bahasa terlalu kasual. Tawarkan benefit personal (free upgrade ribbon, priority delivery) jika sesuai.' },
  { match: /komplain|complaint/, hint: 'Customer ini sedang komplain. Pakai tone empathic: akui keluhan dulu (1 kalimat), minta maaf tulus, baru tawarkan solusi konkret. Hindari bahasa defensif.' },
  { match: /refund/, hint: 'Customer minta refund. Tone empathic + transparan. Jelaskan SOP refund tanpa janji waktu yang tidak pasti. Eskalasi cepat ke operator manusia.' },
  { match: /urgent|mendesak/, hint: 'Customer butuh cepat. Tone responsif & ringkas. Tawarkan opsi same-day jika kota mendukung. Konfirmasi waktu pengiriman eksplisit.' },
  { match: /korporat|corporate|b2b/, hint: 'Customer korporat. Tone formal-profesional, sebut "Bapak/Ibu" bukan "Kak". Siap bantu invoice/PO/NPWP.' },
  { match: /loyal|repeat/, hint: 'Customer loyal (repeat). Tone hangat-personal, boleh sebut histori order singkat sebagai apresiasi.' },
];

async function loadTagsForConv(convId) {
  try {
    const { rows } = await pg.query(
      `SELECT t.name FROM crm_conversation_tags ct
       JOIN crm_tags t ON t.id = ct.tag_id
       WHERE ct.conversation_id = $1`, [convId]
    );
    return rows.map((r) => (r.name || '').toLowerCase());
  } catch { return []; }
}

async function buildToneOverlay(convId) {
  const names = await loadTagsForConv(convId);
  if (!names.length) return '';
  const hints = new Set();
  for (const n of names) {
    for (const rule of TAG_TONE_RULES) {
      if (rule.match.test(n)) hints.add(rule.hint);
    }
  }
  if (!hints.size) return '';
  return `\n\n=== TONE OVERLAY (dari tag conversation) ===\n${[...hints].map((h) => '- ' + h).join('\n')}\n=== END TONE ===`;
}

async function buildSystemPrompt({ conv, customerName, cityHint }) {
  const active = await loadPromptForConversation(conv);
  const orders = await fetchRecentOrders(conv.customer_id, 3);
  const queriesBlock = await listNamedQueriesForPrompt();
  const toneOverlay = await buildToneOverlay(conv.id);
  const langDirective = conv.detected_language && conv.detected_language !== 'id'
    ? `\n\n=== LANGUAGE OVERRIDE ===\nCustomer menulis dalam bahasa "${conv.detected_language}". Balas DALAM BAHASA YANG SAMA dengan tone setara persona Tiara. Jika ragu, fallback ke Bahasa Indonesia.\n=== END LANGUAGE ===`
    : '';

  const customerLine = conv.customer_id
    ? `- Customer ID: ${conv.customer_id}, Nama: ${customerName || '(tidak diketahui)'}`
    : '- Customer baru / belum terhubung ke akun Prestisa';

  const cityLine = cityHint ? `- Kota terdeteksi (dari order historis): ${cityHint}` : '';
  const intentLine = conv.last_intent ? `- Intent terakhir: ${conv.last_intent}` : '';

  const dynamic = `
=== KONTEKS DINAMIS (jangan tampilkan ke customer) ===
- Phone: ${conv.phone}
${customerLine}
${cityLine}
${intentLine}
- 3 order terakhir:
${summarizeOrders(orders)}
=== END KONTEKS ===`.trim();

  return `${active.prompt_text}\n\n${dynamic}${toneOverlay}${langDirective}${queriesBlock}`;
}

function buildHistoryMessages(rows) {
  const out = [];
  for (const r of rows) {
    const body = (r.body || '').toString().trim();
    if (!body) continue;
    if (r.direction === 'in') {
      out.push({ role: 'user', content: body });
    } else {
      const prefix = r.sender_type === 'staff' ? '[operator] ' : '';
      out.push({ role: 'assistant', content: `${prefix}${body}` });
    }
  }
  return out;
}

module.exports = { loadActivePrompt, loadPromptForConversation, buildSystemPrompt, buildHistoryMessages };
