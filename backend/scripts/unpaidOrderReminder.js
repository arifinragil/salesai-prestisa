// #3 Unpaid order reminder — every 10 min via cron.
// Find orders created via Tiara link (utm_content matches crm_conversations.last_order_url_ref)
// that are unpaid >30 min and <24h old, schedule a single gentle reminder.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('../services/logger');

async function run() {
  const { rows: convs } = await pg.query(
    `SELECT id AS conversation_id, phone, last_order_url_ref
     FROM crm_conversations
     WHERE last_order_url_ref IS NOT NULL
       AND last_order_url_sent_at > now() - interval '24 hours'`
  );
  if (!convs.length) { logger.info('[unpaid] no recent links'); await pg.end(); await mysql.end(); return; }
  const refs = convs.map((c) => c.last_order_url_ref);

  let orders = [];
  try {
    const [rows] = await mysql.query(
      `SELECT id, total, payment_status, status, created_at, utm_content
       FROM \`order\`
       WHERE utm_content IN (?) AND deleted_at IS NULL
         AND created_at > NOW() - INTERVAL 24 HOUR
         AND created_at < NOW() - INTERVAL 30 MINUTE
         AND payment_status IN ('unpaid','pending','waiting','')`,
      [refs]
    );
    orders = rows;
  } catch (err) {
    logger.warn({ err: err.message }, '[unpaid] order.utm_content missing or query failed — skip');
    await pg.end(); await mysql.end(); return;
  }
  if (!orders.length) { logger.info('[unpaid] no unpaid orders'); await pg.end(); await mysql.end(); return; }

  let scheduled = 0;
  for (const o of orders) {
    const conv = convs.find((c) => c.last_order_url_ref === o.utm_content);
    if (!conv) continue;
    // Skip if a reminder already exists (any status) for this order
    const dup = await pg.query(
      `SELECT 1 FROM crm_followups
       WHERE conversation_id = $1 AND kind = 'unpaid_reminder'
         AND (context->>'order_id')::int = $2`,
      [conv.conversation_id, o.id]
    );
    if (dup.rows.length) continue;

    const body = `Halo Kak 🌷 pesanan #${o.id} masih menunggu pembayaran ya. Kalau butuh bantuan transfer atau ingin ganti metode pembayaran, balas chat ini saja. Terima kasih!`;
    await pg.query(
      `INSERT INTO crm_followups (conversation_id, kind, body_template, context, scheduled_for, status)
       VALUES ($1, 'unpaid_reminder', $2, $3, now(), 'pending')`,
      [conv.conversation_id, body, JSON.stringify({ order_id: o.id, total: o.total })]
    );
    scheduled++;
  }
  logger.info({ scheduled, candidates: orders.length }, '[unpaid] done');
  await pg.end(); await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message, stack: err.stack }, '[unpaid] failed'); process.exit(1); });
}

module.exports = { run };
