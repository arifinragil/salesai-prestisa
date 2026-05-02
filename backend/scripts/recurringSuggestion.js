// #4 Recurring/anniversary suggestion — daily 09:00 WIB.
// For each conversation linked to a customer, find past order_items whose delivery date
// is N years ago (1, 2, 3, ...) within the next 5 days. Schedule a soft suggestion.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('../services/logger');

const LOOKAHEAD_DAYS = 5;

async function run() {
  const { rows: convs } = await pg.query(
    `SELECT id AS conversation_id, customer_id, phone
     FROM crm_conversations
     WHERE customer_id IS NOT NULL
       AND ai_enabled = TRUE
       AND status != 'closed'
       AND (snoozed_until IS NULL OR snoozed_until < now())`
  );
  if (!convs.length) { logger.info('[recurring] no eligible convs'); await pg.end(); await mysql.end(); return; }

  let scheduled = 0, scanned = 0;
  for (const conv of convs) {
    scanned++;
    let hits = [];
    try {
      const [rows] = await mysql.query(
        `SELECT receiver_name, city AS city_id, date_time,
                TIMESTAMPDIFF(YEAR, date_time, CURDATE()) AS years_ago
         FROM order_items oi
         JOIN \`order\` o ON o.id = oi.order_id
         WHERE o.customer_id = ?
           AND o.deleted_at IS NULL AND oi.deleted_at IS NULL
           AND oi.receiver_name IS NOT NULL AND oi.receiver_name != ''
           AND oi.date_time IS NOT NULL
           AND DATE_FORMAT(oi.date_time, '%m-%d') BETWEEN DATE_FORMAT(CURDATE(), '%m-%d')
                                                    AND DATE_FORMAT(CURDATE() + INTERVAL ? DAY, '%m-%d')
           AND TIMESTAMPDIFF(YEAR, oi.date_time, CURDATE()) >= 1`,
        [conv.customer_id, LOOKAHEAD_DAYS]
      );
      hits = rows;
    } catch (err) {
      logger.warn({ err: err.message, customer_id: conv.customer_id }, '[recurring] mysql query failed');
      continue;
    }
    if (!hits.length) continue;

    // Group by receiver_name, take soonest upcoming
    const byReceiver = new Map();
    for (const h of hits) {
      const key = h.receiver_name.toLowerCase().trim();
      if (!byReceiver.has(key)) byReceiver.set(key, h);
    }
    for (const h of byReceiver.values()) {
      // dedupe — one suggestion per (conv, receiver) per 365 days
      const dup = await pg.query(
        `SELECT 1 FROM crm_followups
         WHERE conversation_id = $1 AND kind = 'recurring_suggestion'
           AND (context->>'receiver') = $2
           AND created_at > now() - interval '365 days'`,
        [conv.conversation_id, h.receiver_name]
      );
      if (dup.rows.length) continue;

      const dt = new Date(h.date_time);
      const dateStr = dt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });
      const body = `Halo Kak 🌷 sekitar tanggal ${dateStr} ${h.years_ago} tahun lalu, Kakak pernah kirim bunga ke ${h.receiver_name}. Kalau berkenan, kami siap bantu siapkan rangkaian baru untuk momen spesialnya tahun ini. Mau dibantu pilihkan?`;
      await pg.query(
        `INSERT INTO crm_followups (conversation_id, kind, body_template, context, scheduled_for, status)
         VALUES ($1, 'recurring_suggestion', $2, $3, now() + interval '5 minutes', 'pending')`,
        [conv.conversation_id, body, JSON.stringify({ receiver: h.receiver_name, years_ago: h.years_ago, original_date: h.date_time })]
      );
      scheduled++;
    }
  }
  logger.info({ scanned, scheduled }, '[recurring] done');
  await pg.end(); await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message, stack: err.stack }, '[recurring] failed'); process.exit(1); });
}

module.exports = { run };
