// #10 Topic auto-tag — map intent classifier output to a managed tag set.
// Tags are auto-created with a known color if missing. Idempotent attach.
const pg = require('../db/postgres');

// intent → { slug, label, color }
const INTENT_TAG = {
  order_intent: { slug: 'order-intent', label: 'Niat Order', color: 'emerald' },
  order_status: { slug: 'order-status', label: 'Cek Order', color: 'blue' },
  pricing: { slug: 'pricing', label: 'Tanya Harga', color: 'amber' },
  shipping: { slug: 'shipping', label: 'Ongkir/Kirim', color: 'sky' },
  payment: { slug: 'payment', label: 'Pembayaran', color: 'indigo' },
  faq: { slug: 'faq', label: 'FAQ', color: 'slate' },
  complaint: { slug: 'complaint', label: 'Komplain', color: 'rose' },
  refund: { slug: 'refund', label: 'Refund', color: 'rose' },
  cancel: { slug: 'cancel', label: 'Cancel', color: 'rose' },
};

async function ensureTag(client, def) {
  const { rows } = await client.query(
    `SELECT id FROM crm_tags WHERE LOWER(name) = LOWER($1) LIMIT 1`, [def.label]
  );
  if (rows[0]) return rows[0].id;
  const ins = await client.query(
    `INSERT INTO crm_tags (name, color, description, created_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [def.label, def.color, `Auto-tagged by intent classifier (${def.slug})`]
  );
  return ins.rows[0].id;
}

async function attach(client, convId, intent) {
  const def = INTENT_TAG[intent];
  if (!def) return null;
  try {
    const tagId = await ensureTag(client, def);
    await client.query(
      `INSERT INTO crm_conversation_tags (conversation_id, tag_id, auto_tagged)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (conversation_id, tag_id) DO NOTHING`,
      [convId, tagId]
    );
    return def.slug;
  } catch (err) {
    return null;
  }
}

module.exports = { attach, INTENT_TAG };
