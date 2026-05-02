// #14+#15+#16 Delivery comms — every 15 min.
// 1) paid_confirm   — sent right after order moves to paid (delta poll)
// 2) pre_delivery   — H-1 sebelum delivery_date (jam 17:00 WIB ideally)
// 3) post_delivery  — H+1 setelah delivery_date (minta CSAT + review)
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const wa = require('../services/waClient');
const logger = require('../services/logger');

async function findConv(customerId, phone) {
  const r = await pg.query(
    `SELECT id, phone, wa_session, ai_enabled, status FROM crm_conversations
     WHERE customer_id = $1 OR phone = $2 OR real_phone = $2
     ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
    [customerId, phone]
  );
  return r.rows[0] || null;
}

async function sendPush({ orderId, kind, body, conv }) {
  // dedupe
  const dup = await pg.query(
    `SELECT 1 FROM crm_delivery_pushes WHERE order_id = $1 AND kind = $2`,
    [orderId, kind]
  );
  if (dup.rows.length) return { skipped: 'dup' };
  if (!conv?.phone) return { skipped: 'no_conv' };
  try {
    const sent = await wa.sendText({ phone: conv.phone, text: body, session: conv.wa_session });
    await pg.query(
      `INSERT INTO crm_delivery_pushes (order_id, conversation_id, kind, status, body)
       VALUES ($1, $2, $3, 'sent', $4)`,
      [orderId, conv.id, kind, body]
    );
    await pg.query(
      `INSERT INTO crm_messages (conversation_id, direction, sender_type, body, message_type, send_status, waha_message_id, ai_metadata)
       VALUES ($1, 'out', 'system', $2, 'text', 'sent', $3, $4)`,
      [conv.id, body, sent?.id || null, JSON.stringify({ delivery_push: kind, order_id: orderId })]
    );
    return { sent: true };
  } catch (err) {
    await pg.query(
      `INSERT INTO crm_delivery_pushes (order_id, conversation_id, kind, status, body)
       VALUES ($1, $2, $3, 'failed', $4)`,
      [orderId, conv?.id || null, kind, body]
    );
    return { error: err.message };
  }
}

async function processPaidConfirm() {
  // Orders moved to paid in last 30 min that haven't been pushed yet
  const [orders] = await mysql.query(
    `SELECT o.id, o.order_number, o.customer_id, o.total, c.phone
     FROM \`order\` o
     LEFT JOIN customer c ON c.id = o.customer_id
     WHERE o.payment_status = 'paid' AND o.deleted_at IS NULL
       AND o.updated_at > NOW() - INTERVAL 30 MINUTE
     LIMIT 20`
  );
  for (const o of orders) {
    const conv = await findConv(o.customer_id, o.phone);
    const body = `🌷 Terima kasih Kak! Pembayaran untuk pesanan #${o.order_number || o.id} sudah kami terima ✅\n\nTim kami akan segera memproses dan kirim sesuai jadwal. Kalau ada perubahan alamat/detail, balas chat ini sebelum proses pengiriman ya 🙏`;
    const r = await sendPush({ orderId: o.id, kind: 'paid_confirm', body, conv });
    if (r.sent) logger.info({ order_id: o.id, kind: 'paid_confirm' }, '[delivery] sent');
  }
}

async function processPreDelivery() {
  // Orders dengan delivery date = besok, paid, belum di-push
  const [orders] = await mysql.query(
    `SELECT o.id, o.order_number, o.customer_id, c.phone,
            oi.receiver_name, oi.date_time AS delivery_date
     FROM \`order\` o
     JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
     LEFT JOIN customer c ON c.id = o.customer_id
     WHERE o.payment_status = 'paid' AND o.deleted_at IS NULL
       AND DATE(oi.date_time) = DATE(NOW() + INTERVAL 1 DAY)
     LIMIT 50`
  );
  for (const o of orders) {
    const conv = await findConv(o.customer_id, o.phone);
    const body = `Halo Kak 🌷 mengingatkan, pesanan #${o.order_number || o.id} ke ${o.receiver_name || '(penerima)'} dijadwal kirim BESOK.\n\nKalau ada perubahan alamat / waktu / penerima, mohon konfirmasi sekarang ya. Kalau semua sudah benar, balas "OK" saja 🙏`;
    const r = await sendPush({ orderId: o.id, kind: 'pre_delivery', body, conv });
    if (r.sent) logger.info({ order_id: o.id, kind: 'pre_delivery' }, '[delivery] sent');
  }
}

async function processPostDelivery() {
  // Orders kemarin yang sudah delivered (delivery_date = kemarin), minta CSAT
  const [orders] = await mysql.query(
    `SELECT o.id, o.order_number, o.customer_id, c.phone, oi.receiver_name
     FROM \`order\` o
     JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
     LEFT JOIN customer c ON c.id = o.customer_id
     WHERE o.payment_status = 'paid' AND o.deleted_at IS NULL
       AND DATE(oi.date_time) = DATE(NOW() - INTERVAL 1 DAY)
     LIMIT 50`
  );
  for (const o of orders) {
    const conv = await findConv(o.customer_id, o.phone);
    const body = `Halo Kak 🌷 semoga rangkaian untuk ${o.receiver_name || 'momen kemarin'} berkesan ya 💐\n\nBoleh kasih rating pengalaman chat & pengiriman? Ketik 1-5:\n1 = sangat tidak puas\n5 = sangat puas\n\nKritik/saran sangat membantu kami berkembang 🙏`;
    const r = await sendPush({ orderId: o.id, kind: 'post_delivery', body, conv });
    if (r.sent) logger.info({ order_id: o.id, kind: 'post_delivery' }, '[delivery] sent');
  }
}

async function run() {
  try { await processPaidConfirm(); } catch (e) { logger.warn({ err: e.message }, '[delivery] paid_confirm err'); }
  try { await processPreDelivery(); } catch (e) { logger.warn({ err: e.message }, '[delivery] pre err'); }
  try { await processPostDelivery(); } catch (e) { logger.warn({ err: e.message }, '[delivery] post err'); }
  await pg.end(); await mysql.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[delivery] failed'); process.exit(1); });
}
module.exports = { run };
