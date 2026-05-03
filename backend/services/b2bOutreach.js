// backend/services/b2bOutreach.js
// B2B outreach engine — sequenced cold/warm WA outreach with auto opt-out
// + reply detection. Reuses crm_followups + followupWorker as delivery pipe.

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const logger = require('./logger');

const OPT_OUT_FOOTER = '\n\n_Balas STOP untuk berhenti menerima._';
const SEND_DELAY_MIN = 5; // small delay so admin still has chance to pause

function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/\D/g, '');
  if (s.startsWith('0')) s = '62' + s.slice(1);
  if (!s.startsWith('62')) return null;
  return s;
}

function firstName(raw) {
  if (!raw) return '';
  const COMPANY = /^(pt\.?|cv\.?|kopkar|koperasi|yayasan|toko)\b/i;
  const HONOR = /^(ibu|bpk|bapak|pak|bu|mr|mrs|ms|drs|dr|ir|hj|h\.?)\.?$/i;
  const s = String(raw).trim();
  if (COMPANY.test(s)) return '';
  const tokens = s.split(/\s+/).filter((t) => !HONOR.test(t));
  if (!tokens[0]) return '';
  const f = tokens[0].replace(/[^a-zA-ZÀ-ÿ-]/g, '');
  if (f.length < 2 || f.length > 20) return '';
  return f[0].toUpperCase() + f.slice(1).toLowerCase();
}

function renderTemplate(body, prospect) {
  const name = firstName(prospect.customer_name);
  const greet = name ? `Halo Kak ${name}` : 'Halo Kak';
  return body
    .replace(/\{greet\}/g, greet)
    .replace(/\{name\}/g, name || '')
    .replace(/\{company\}/g, prospect.customer_name || '');
}

// --- Prospect preview (reuses konsumen general-blast query, b2b only) ---
async function previewProspects(filters = {}) {
  const {
    last_buy_from = null, last_buy_to = null,
    total_spent_min = null, total_spent_max = null,
    qty_min = null, qty_max = null,
    has_complaint = null,
    occasions = null, product_category_ids = null,
    customer_type = 'b2b',
  } = filters;
  // customer.type is INT in MySQL (0=B2C, 1=B2B). Map string → int.
  const customerTypeInt = customer_type === 'b2b' ? 1 : customer_type === 'b2c' ? 0 : null;

  const preParams = [];
  const params = [];
  const lastOrderHaving = [];
  if (last_buy_from) { lastOrderHaving.push('MAX(created_at) >= ?'); preParams.push(last_buy_from); }
  if (last_buy_to)   { lastOrderHaving.push('MAX(created_at) < DATE_ADD(?, INTERVAL 1 DAY)'); preParams.push(last_buy_to); }

  const itemConds = ['oi.deleted_at IS NULL'];
  if (Array.isArray(occasions) && occasions.length) {
    itemConds.push('oi.occasion IN (?)'); params.push(occasions);
  }
  const wheres = ['c.deleted_at IS NULL', 'c.phone IS NOT NULL', "c.phone != ''"];
  if (customerTypeInt !== null) { wheres.push('c.type = ?'); params.push(customerTypeInt); }
  if (Array.isArray(product_category_ids) && product_category_ids.length) {
    wheres.push('p.category_id IN (?)'); params.push(product_category_ids);
  }
  if (has_complaint === 'yes') wheres.push(`EXISTS (SELECT 1 FROM order_problems op JOIN \`order\` o2 ON o2.id=op.order_id WHERE o2.customer_id=c.id AND op.deleted_at IS NULL AND op.amount_customer_debit>0)`);
  if (has_complaint === 'no') wheres.push(`NOT EXISTS (SELECT 1 FROM order_problems op JOIN \`order\` o2 ON o2.id=op.order_id WHERE o2.customer_id=c.id AND op.deleted_at IS NULL AND op.amount_customer_debit>0)`);

  const havings = [];
  if (total_spent_min != null && total_spent_min !== '') { havings.push('SUM(o.total) >= ?'); params.push(Number(total_spent_min)); }
  if (total_spent_max != null && total_spent_max !== '') { havings.push('SUM(o.total) <= ?'); params.push(Number(total_spent_max)); }
  if (qty_min != null && qty_min !== '')                 { havings.push('COUNT(oi.id) >= ?'); params.push(Number(qty_min)); }
  if (qty_max != null && qty_max !== '')                 { havings.push('COUNT(oi.id) <= ?'); params.push(Number(qty_max)); }

  const sql = `
    SELECT c.id AS customer_id, c.name AS customer_name, c.phone, c.type AS customer_type,
           COALESCE(SUM(o.total), 0) AS total_spent,
           COALESCE(COUNT(oi.id), 0) AS total_items,
           lo.last_order_at AS last_order_date
    FROM (
      SELECT customer_id, MAX(created_at) AS last_order_at
      FROM \`order\`
      WHERE deleted_at IS NULL AND status != 'cancelled'
      GROUP BY customer_id
      ${lastOrderHaving.length ? 'HAVING ' + lastOrderHaving.join(' AND ') : ''}
    ) lo
    JOIN customer c ON c.id = lo.customer_id
    JOIN \`order\` o ON o.customer_id = c.id AND o.deleted_at IS NULL AND o.status != 'cancelled'
    JOIN order_items oi ON oi.order_id = o.id AND ${itemConds.join(' AND ')}
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE ${wheres.join(' AND ')}
    GROUP BY c.id, c.name, c.phone, c.type, lo.last_order_at
    ${havings.length ? 'HAVING ' + havings.join(' AND ') : ''}
    ORDER BY lo.last_order_at DESC LIMIT 1000`;

  const [rows] = await mysql.query(sql, [...preParams, ...params]);
  return rows;
}

// --- Campaign create (draft) ---
async function createCampaign({ name, sequence, filters, prospects, createdBy }) {
  if (!name || !Array.isArray(sequence) || sequence.length === 0) throw new Error('name + sequence required');
  for (const s of sequence) {
    if (typeof s.body_template !== 'string' || !s.body_template.trim()) throw new Error('each step needs body_template');
    if (typeof s.delay_days !== 'number' || s.delay_days < 0) throw new Error('each step needs delay_days >= 0');
  }
  const c = await pg.query(
    `INSERT INTO crm_b2b_campaigns (name, sequence, filters, status, created_by)
     VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
    [name.slice(0, 120), JSON.stringify(sequence), filters ? JSON.stringify(filters) : null, createdBy || null]
  );
  const campaignId = c.rows[0].id;

  let added = 0;
  for (const p of prospects || []) {
    const phone = normalizePhone(p.phone);
    if (!phone) continue;
    try {
      await pg.query(
        `INSERT INTO crm_b2b_prospects (campaign_id, customer_id, customer_name, phone, context)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, phone) DO NOTHING`,
        [campaignId, p.customer_id || null, p.customer_name || null, phone,
         JSON.stringify({ total_spent: p.total_spent, total_items: p.total_items, last_order_date: p.last_order_date })]
      );
      added++;
    } catch (err) { logger.warn({ err: err.message, phone }, '[b2b] prospect insert skip'); }
  }
  return { campaign_id: campaignId, prospects_added: added };
}

// --- Launch (activate + schedule first step) ---
async function launchCampaign(campaignId) {
  const c = await pg.query(`SELECT id, sequence, status FROM crm_b2b_campaigns WHERE id = $1`, [campaignId]);
  if (!c.rows[0]) throw new Error('campaign not found');
  if (c.rows[0].status === 'cancelled' || c.rows[0].status === 'completed') throw new Error('campaign closed');
  await pg.query(
    `UPDATE crm_b2b_campaigns SET status = 'active', launched_at = COALESCE(launched_at, now()) WHERE id = $1`,
    [campaignId]
  );
  // Schedule next_step_at = now() + SEND_DELAY_MIN for prospects still pending
  await pg.query(
    `UPDATE crm_b2b_prospects
     SET next_step_at = now() + interval '${SEND_DELAY_MIN} minutes', status = 'in_progress'
     WHERE campaign_id = $1 AND status = 'pending' AND next_step_at IS NULL`,
    [campaignId]
  );
  return { ok: true };
}

async function setCampaignStatus(campaignId, status) {
  if (!['active', 'paused', 'cancelled', 'completed'].includes(status)) throw new Error('bad status');
  await pg.query(`UPDATE crm_b2b_campaigns SET status = $2 WHERE id = $1`, [campaignId, status]);
  return { ok: true };
}

// --- Conversation stub for prospect (so reply lands in inbox) ---
async function ensureConversation(phone, customerId) {
  const r = await pg.query(`SELECT id FROM crm_conversations WHERE phone = $1 OR real_phone = $1 LIMIT 1`, [phone]);
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

// --- Tick: advance due prospects ---
async function tick() {
  const r = await pg.query(
    `SELECT p.id AS prospect_id, p.campaign_id, p.customer_id, p.customer_name, p.phone,
            p.current_step, p.conversation_id, p.context, c.sequence
     FROM crm_b2b_prospects p
     JOIN crm_b2b_campaigns c ON c.id = p.campaign_id
     WHERE p.status IN ('pending','in_progress')
       AND p.next_step_at IS NOT NULL AND p.next_step_at <= now()
       AND c.status = 'active'
     ORDER BY p.next_step_at ASC LIMIT 100`
  );
  let sent = 0, optedOut = 0, replied = 0, completed = 0;
  for (const p of r.rows) {
    const nextStepIdx = p.current_step;
    if (nextStepIdx >= p.sequence.length) {
      await pg.query(`UPDATE crm_b2b_prospects SET status = 'completed', next_step_at = NULL WHERE id = $1`, [p.prospect_id]);
      completed++; continue;
    }
    const convId = p.conversation_id || (await ensureConversation(p.phone, p.customer_id));
    if (!p.conversation_id) {
      await pg.query(`UPDATE crm_b2b_prospects SET conversation_id = $2 WHERE id = $1`, [p.prospect_id, convId]);
    }

    // Opt-out check (existing aiAgent sets ai_paused_until on STOP)
    const conv = (await pg.query(
      `SELECT ai_paused_until, status FROM crm_conversations WHERE id = $1`, [convId]
    )).rows[0];
    if (conv?.ai_paused_until && new Date(conv.ai_paused_until) > new Date()) {
      await pg.query(`UPDATE crm_b2b_prospects SET status = 'opted_out', next_step_at = NULL WHERE id = $1`, [p.prospect_id]);
      await pg.query(
        `INSERT INTO crm_b2b_step_log (prospect_id, step_index, result) VALUES ($1, $2, 'cancel:opted_out')`,
        [p.prospect_id, nextStepIdx]
      );
      optedOut++; continue;
    }

    // Reply check — if customer sent any inbound after we started, mark replied
    const replyQ = await pg.query(
      `SELECT 1 FROM crm_messages
       WHERE conversation_id = $1 AND direction = 'in' AND created_at > $2 LIMIT 1`,
      [convId, p.context?.added_at || new Date(Date.now() - 365 * 86400_000).toISOString()]
    );
    if (replyQ.rows.length) {
      await pg.query(
        `UPDATE crm_b2b_prospects SET status = 'replied', reply_at = now(), next_step_at = NULL WHERE id = $1`,
        [p.prospect_id]
      );
      await pg.query(
        `INSERT INTO crm_b2b_step_log (prospect_id, step_index, result) VALUES ($1, $2, 'cancel:replied')`,
        [p.prospect_id, nextStepIdx]
      );
      replied++; continue;
    }

    // Render + queue followup
    const stepDef = p.sequence[nextStepIdx];
    const body = renderTemplate(stepDef.body_template, p) + OPT_OUT_FOOTER;
    const fu = await pg.query(
      `INSERT INTO crm_followups (conversation_id, kind, body_template, scheduled_for, status)
       VALUES ($1, $2, $3, now() + interval '${SEND_DELAY_MIN} minutes', 'pending') RETURNING id`,
      [convId, `b2b_step_${nextStepIdx + 1}`, body]
    );
    await pg.query(
      `INSERT INTO crm_b2b_step_log (prospect_id, step_index, followup_id, scheduled_for, result)
       VALUES ($1, $2, $3, now() + interval '${SEND_DELAY_MIN} minutes', 'queued')`,
      [p.prospect_id, nextStepIdx, fu.rows[0].id]
    );

    // Schedule next step or mark complete
    const newStep = nextStepIdx + 1;
    if (newStep >= p.sequence.length) {
      await pg.query(
        `UPDATE crm_b2b_prospects SET current_step = $2, last_step_at = now(), next_step_at = NULL,
                status = 'completed' WHERE id = $1`,
        [p.prospect_id, newStep]
      );
      completed++;
    } else {
      const nextDelay = p.sequence[newStep].delay_days || 1;
      await pg.query(
        `UPDATE crm_b2b_prospects SET current_step = $2, last_step_at = now(),
                next_step_at = now() + ($3 || ' days')::interval WHERE id = $1`,
        [p.prospect_id, newStep, String(nextDelay)]
      );
    }
    sent++;
  }
  logger.info({ candidates: r.rows.length, sent, optedOut, replied, completed }, '[b2b] tick');
  return { sent, optedOut, replied, completed };
}

module.exports = {
  previewProspects, createCampaign, launchCampaign, setCampaignStatus, tick,
};
