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

async function buildSystemPrompt({ conv, customerName, cityHint }) {
  const active = await loadActivePrompt();
  const orders = await fetchRecentOrders(conv.customer_id, 3);
  const queriesBlock = await listNamedQueriesForPrompt();

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

  return `${active.prompt_text}\n\n${dynamic}${queriesBlock}`;
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

module.exports = { loadActivePrompt, buildSystemPrompt, buildHistoryMessages };
