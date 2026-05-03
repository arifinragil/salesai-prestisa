// backend/services/retentionEngine.js
// Lifecycle / retention engine. Three jobs:
//   1) Dormant detect (warm 30d / cold 60d / dead 90d) — auto WA blast
//   2) Win-back lost customers (pipeline lost in last 30/60d) — promo code
//   3) Moments (birthday + anniversary in next 30d) — gentle reminder
//
// Customer source: MySQL prestisa.customer + order. Reused RFM logic from
// /home/krttpt/konsumen/backend/queries/customers.js.
//
// Delivery: inserts into crm_followups → existing followupWorker cron sends.
// Dedup: crm_retention_actions table.

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('./logger');

// --- Tunables (per spec confirmation) ---
const DORMANT_TIERS = [
  { key: 'dormant_warm', minDays: 30, maxDays: 59, dedupDays: 30 },
  { key: 'dormant_cold', minDays: 60, maxDays: 89, dedupDays: 45 },
  { key: 'dormant_dead', minDays: 90, maxDays: 365, dedupDays: 60 },
];
const WINBACK_LOOKBACK_DAYS = 60;
const WINBACK_DISCOUNT_PCT = 15;
const WINBACK_PROMO_VALID_DAYS = 14;
const MOMENTS_DAYS_AHEAD = 14;
const BATCH_LIMIT = 50; // safety cap per cron run

// Extract a clean personal first-name for templating, or empty string when
// the customer is a company / unparseable. We greet "Kak <Name>" only if name
// is clean; otherwise just "Kak" (no awkward "Kak PT.", "Kak Ibu").
const COMPANY_PREFIX = /^(pt\.?|cv\.?|kopkar|koperasi|yayasan|toko|cv|tk|sd|smp|sma|smk|rs|rsia|rsu|klinik|hotel|apartemen)\b/i;
const HONORIFIC = /^(ibu|bpk|bapak|pak|bu|mr|mrs|ms|sdr|sdri|drs|dr|ir|hj|h\.?)\.?$/i;
function firstName(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (COMPANY_PREFIX.test(s)) return ''; // company → no personal greeting
  // Take tokens, drop honorifics
  const tokens = s.split(/\s+/).filter((t) => !HONORIFIC.test(t));
  if (tokens.length === 0) return '';
  const first = tokens[0].replace(/[^a-zA-ZÀ-ÿ-]/g, '');
  if (first.length < 2 || first.length > 20) return '';
  // Title-case
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}
function greet(c) {
  const name = firstName(c.name);
  return name ? `Halo Kak ${name}` : 'Halo Kak';
}

const TEMPLATES = {
  dormant_warm: (c) =>
    `${greet(c)} 🌷 Tiara dari Prestisa. Sudah sebulan kita nggak ngobrol — semoga sehat selalu. Lagi ada momen spesial yang perlu dirayakan? Mau Tiara bantu siapkan?`,
  dormant_cold: (c) =>
    `${greet(c)} ✨ Sudah agak lama nih kita nggak terhubung. Kami ada beberapa pilihan baru yang mungkin Kakak suka — boleh Tiara kirim katalog?`,
  dormant_dead: (c) =>
    `${greet(c)} 💐 Sudah 3 bulan lebih kita nggak ngobrol. Kalau ada apa-apa yang bisa kami perbaiki dari pengalaman terakhir, kami siap dengar. Atau kalau ada momen spesial, kami siap bantu lagi 🙏`,
  winback: (c, code) =>
    `${greet(c)} 🌹 Kami merindukan Kakak. Sebagai apresiasi, ada kode khusus *${code}* (diskon ${WINBACK_DISCOUNT_PCT}%, valid ${WINBACK_PROMO_VALID_DAYS} hari). Pakai saat order ya — link order kami kirim setelah Kakak balas chat ini.`,
  moment_birthday: (c, m) =>
    `${greet(c)} 🎂 Tiara dari Prestisa. Tanggal ${m.dateLabel} ulang tahun ${m.receiver || 'orang spesial'} ya — mau pesan bunga atau cake untuk hari itu? Kami bantu siapkan.`,
  moment_anniversary: (c, m) =>
    `${greet(c)} 💐 Tanggal ${m.dateLabel} anniversary ya — kalau Kakak ingin kirim sesuatu yang spesial, kami siap bantu. Mau lihat pilihan rangkaian?`,
};

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0')) s = '62' + s.slice(1);
  if (!s.startsWith('62')) return null;
  return s;
}

// Find or create stub crm_conversation for a phone — needed because dormant
// customers may never have chatted before via Tiara.
async function ensureConversation(phone, customerId) {
  if (!phone) return null;
  const r = await pg.query(
    `SELECT id FROM crm_conversations WHERE phone = $1 OR real_phone = $1 LIMIT 1`,
    [phone]
  );
  if (r.rows[0]) return r.rows[0].id;
  const ins = await pg.query(
    `INSERT INTO crm_conversations (phone, customer_id, status, last_message_at, ai_enabled)
     VALUES ($1, $2, 'active', now(), TRUE)
     ON CONFLICT (phone) DO UPDATE SET customer_id = COALESCE(crm_conversations.customer_id, EXCLUDED.customer_id)
     RETURNING id`,
    [phone, customerId || null]
  );
  return ins.rows[0].id;
}

async function alreadyActioned(customerId, kind, refDate, dedupDays) {
  const r = await pg.query(
    `SELECT 1 FROM crm_retention_actions
     WHERE customer_id = $1 AND action_kind = $2
       AND created_at > now() - ($3 || ' days')::interval
       ${refDate ? 'AND reference_date = $4' : ''}
     LIMIT 1`,
    refDate ? [customerId, kind, String(dedupDays), refDate] : [customerId, kind, String(dedupDays)]
  );
  return r.rows.length > 0;
}

async function recordAction({ customerId, phone, kind, refDate, convId, followupId, promoCode, context }) {
  await pg.query(
    `INSERT INTO crm_retention_actions
       (customer_id, phone, action_kind, reference_date, conversation_id, followup_id, promo_code, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [customerId, phone || null, kind, refDate || null, convId || null, followupId || null, promoCode || null,
      context ? JSON.stringify(context) : null]
  );
}

async function scheduleFollowup(convId, kind, body, delayMinutes = 5) {
  const r = await pg.query(
    `INSERT INTO crm_followups (conversation_id, kind, body_template, scheduled_for, status)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, 'pending')
     RETURNING id`,
    [convId, kind, body, String(delayMinutes)]
  );
  return r.rows[0].id;
}

// ── 1. DORMANT ─────────────────────────────────────────────────────────────
async function processDormant() {
  let totalScheduled = 0;
  for (const tier of DORMANT_TIERS) {
    const [rows] = await mysql.query(
      `SELECT c.id AS customer_id, c.name, c.phone,
              MAX(o.created_at) AS last_order_at,
              DATEDIFF(CURDATE(), MAX(o.created_at)) AS recency_days
       FROM customer c
       JOIN \`order\` o ON o.customer_id = c.id
       WHERE c.deleted_at IS NULL AND o.deleted_at IS NULL AND o.status != 'cancelled'
         AND c.phone IS NOT NULL
       GROUP BY c.id, c.name, c.phone
       HAVING recency_days BETWEEN ? AND ?
       ORDER BY recency_days ASC
       LIMIT ?`,
      [tier.minDays, tier.maxDays, BATCH_LIMIT]
    );
    let scheduled = 0;
    for (const c of rows) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;
      if (await alreadyActioned(c.customer_id, tier.key, null, tier.dedupDays)) continue;
      const convId = await ensureConversation(phone, c.customer_id);
      if (!convId) continue;
      const body = TEMPLATES[tier.key](c);
      const fuId = await scheduleFollowup(convId, tier.key, body);
      await recordAction({ customerId: c.customer_id, phone, kind: tier.key, convId, followupId: fuId,
        context: { recency_days: c.recency_days } });
      scheduled++;
    }
    logger.info({ tier: tier.key, candidates: rows.length, scheduled }, '[retention] dormant');
    totalScheduled += scheduled;
  }
  return totalScheduled;
}

// ── 2. WIN-BACK ────────────────────────────────────────────────────────────
async function processWinback() {
  // Find conversations that landed in 'lost' pipeline stage in last N days
  const r = await pg.query(
    `SELECT c.id AS conv_id, c.customer_id, c.phone, c.real_phone, c.pipeline_stage_at
     FROM crm_conversations c
     WHERE c.pipeline_stage = 'lost'
       AND c.pipeline_stage_at > now() - ($1 || ' days')::interval
       AND c.customer_id IS NOT NULL
     ORDER BY c.pipeline_stage_at DESC LIMIT $2`,
    [String(WINBACK_LOOKBACK_DAYS), BATCH_LIMIT]
  );
  let scheduled = 0;
  for (const conv of r.rows) {
    if (await alreadyActioned(conv.customer_id, 'winback', null, 60)) continue;
    // Get customer name
    let name = null;
    try {
      const [c] = await mysql.query(`SELECT name FROM customer WHERE id = ? LIMIT 1`, [conv.customer_id]);
      name = c[0]?.name;
    } catch {}
    // Generate single-use promo code
    const code = `WB${conv.customer_id}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    try {
      await pg.query(
        `INSERT INTO crm_promo_settings (code, description, discount_pct, starts_at, ends_at, active)
         VALUES ($1, $2, $3, now(), now() + ($4 || ' days')::interval, TRUE)
         ON CONFLICT (code) DO NOTHING`,
        [code, `Win-back single-use for customer #${conv.customer_id}`, WINBACK_DISCOUNT_PCT, String(WINBACK_PROMO_VALID_DAYS)]
      );
    } catch (err) {
      logger.warn({ err: err.message }, '[retention] promo insert failed');
      continue;
    }
    const body = TEMPLATES.winback({ name }, code);
    const fuId = await scheduleFollowup(conv.conv_id, 'winback', body);
    await recordAction({ customerId: conv.customer_id, phone: conv.phone, kind: 'winback',
      convId: conv.conv_id, followupId: fuId, promoCode: code,
      context: { discount_pct: WINBACK_DISCOUNT_PCT, valid_days: WINBACK_PROMO_VALID_DAYS } });
    scheduled++;
  }
  logger.info({ candidates: r.rows.length, scheduled }, '[retention] winback');
  return scheduled;
}

// ── 3. MOMENTS (birthday + anniversary, next N days) ───────────────────────
async function processMoments() {
  const [rows] = await mysql.query(
    `SELECT
       c.id AS customer_id, c.name, c.phone,
       oi.occasion, oi.receiver_name AS receiver,
       DATE_FORMAT(oi.date_time, '%m-%d') AS mmdd,
       DATE(oi.date_time) AS original_date,
       DATEDIFF(
         DATE(CONCAT(
           IF(DATE(CONCAT(YEAR(CURDATE()),'-',DATE_FORMAT(oi.date_time,'%m-%d'))) >= CURDATE(),
              YEAR(CURDATE()), YEAR(CURDATE())+1),
           '-', DATE_FORMAT(oi.date_time,'%m-%d')
         )), CURDATE()
       ) AS days_until,
       DATE(CONCAT(
         IF(DATE(CONCAT(YEAR(CURDATE()),'-',DATE_FORMAT(oi.date_time,'%m-%d'))) >= CURDATE(),
            YEAR(CURDATE()), YEAR(CURDATE())+1),
         '-', DATE_FORMAT(oi.date_time,'%m-%d')
       )) AS next_date
     FROM order_items oi
     JOIN \`order\` o ON oi.order_id = o.id
     JOIN customer c  ON o.customer_id = c.id
     WHERE oi.deleted_at IS NULL AND o.deleted_at IS NULL AND o.status != 'cancelled'
       AND c.deleted_at IS NULL AND c.phone IS NOT NULL
       AND oi.occasion IN ('Anniversary', 'Birthday')
     HAVING days_until BETWEEN 7 AND ?
     ORDER BY days_until ASC LIMIT ?`,
    [MOMENTS_DAYS_AHEAD, BATCH_LIMIT]
  );
  let scheduled = 0;
  for (const m of rows) {
    const phone = normalizePhone(m.phone);
    if (!phone) continue;
    const kind = m.occasion === 'Birthday' ? 'moment_birthday' : 'moment_anniversary';
    const refDate = m.next_date instanceof Date ? m.next_date : new Date(m.next_date);
    const refDateStr = refDate.toISOString().slice(0, 10);
    if (await alreadyActioned(m.customer_id, kind, refDateStr, 365)) continue;
    const convId = await ensureConversation(phone, m.customer_id);
    if (!convId) continue;
    const dateLabel = refDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });
    const body = TEMPLATES[kind]({ name: m.name }, { dateLabel, receiver: m.receiver });
    const fuId = await scheduleFollowup(convId, kind, body);
    await recordAction({ customerId: m.customer_id, phone, kind, refDate: refDateStr,
      convId, followupId: fuId,
      context: { occasion: m.occasion, receiver: m.receiver, days_until: m.days_until, next_date: refDateStr } });
    scheduled++;
  }
  logger.info({ candidates: rows.length, scheduled }, '[retention] moments');
  return scheduled;
}

async function run() {
  const t0 = Date.now();
  const dormant = await processDormant().catch((e) => (logger.warn({err:e.message},'[retention] dormant fail'), 0));
  const winback = await processWinback().catch((e) => (logger.warn({err:e.message},'[retention] winback fail'), 0));
  const moments = await processMoments().catch((e) => (logger.warn({err:e.message},'[retention] moments fail'), 0));
  logger.info({ dormant, winback, moments, ms: Date.now() - t0 }, '[retention] done');
  return { dormant, winback, moments };
}

module.exports = { run, processDormant, processWinback, processMoments };
