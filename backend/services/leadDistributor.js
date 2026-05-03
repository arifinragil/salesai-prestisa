// backend/services/leadDistributor.js
// Auto lead distribution: when a new conv comes in,
//   - lookup customer by phone in MySQL prestisa.customer
//   - if found → assign to least-busy active staff with role='retention'
//   - if not found → assign to least-busy active staff with role='acquisition'
// Skipped if mode='manual' or conv already has assigned_staff_id.

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const settings = require('./settings');
const logger = require('./logger');

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

async function lookupCustomerByPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  // Match on phone last-9-digits (handles 62/0 prefix variants)
  const tail = norm.slice(-9);
  try {
    const [rows] = await mysql.query(
      `SELECT id FROM customer
       WHERE deleted_at IS NULL
         AND RIGHT(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), 9) = ?
       LIMIT 1`,
      [tail]
    );
    return rows[0]?.id || null;
  } catch (err) {
    logger.warn({ err: err.message, phone: norm }, '[leadDist] mysql lookup failed');
    return null;
  }
}

async function pickLeastBusyStaff(role) {
  const r = await pg.query(
    `SELECT u.id, u.username, u.full_name,
            COUNT(c.id) FILTER (WHERE c.status = 'active' AND c.assigned_staff_id = u.id)::int AS open_convs
     FROM staff_users u
     LEFT JOIN crm_conversations c ON c.assigned_staff_id = u.id
     WHERE u.active = TRUE AND u.role = $1
     GROUP BY u.id, u.username, u.full_name
     ORDER BY open_convs ASC, RANDOM() LIMIT 1`,
    [role]
  );
  return r.rows[0] || null;
}

/**
 * Distribute a single conversation. Idempotent — skips if already assigned.
 * Returns { assigned: bool, staff_id?, role?, customer_state, reason? }.
 */
async function distribute(conversationId, opts = {}) {
  const mode = await settings.getSetting('lead_distribution_mode', 'auto');
  if (mode !== 'auto') return { assigned: false, reason: 'mode_manual' };

  const cQ = await pg.query(
    `SELECT id, phone, real_phone, customer_id, assigned_staff_id
     FROM crm_conversations WHERE id = $1`,
    [conversationId]
  );
  const conv = cQ.rows[0];
  if (!conv) return { assigned: false, reason: 'conv_not_found' };
  if (conv.assigned_staff_id && !opts.force) {
    return { assigned: false, reason: 'already_assigned', staff_id: conv.assigned_staff_id };
  }

  const phone = conv.real_phone || conv.phone;
  const customerId = conv.customer_id || (await lookupCustomerByPhone(phone));
  const customerState = customerId ? 'existing' : 'new';
  const role = customerState === 'existing' ? 'retention' : 'acquisition';

  const staff = await pickLeastBusyStaff(role);
  if (!staff) {
    logger.info({ conv_id: conversationId, role, customerState }, '[leadDist] no eligible staff');
    await pg.query(
      `INSERT INTO crm_lead_assignments (conversation_id, staff_id, role, source, customer_state)
       VALUES ($1, NULL, $2, 'auto', $3)`,
      [conversationId, role, customerState]
    );
    return { assigned: false, reason: 'no_eligible_staff', role, customer_state: customerState };
  }

  await pg.query(
    `UPDATE crm_conversations SET assigned_staff_id = $2 WHERE id = $1`,
    [conversationId, staff.id]
  );
  // Persist customer_id if we just discovered it
  if (!conv.customer_id && customerId) {
    await pg.query(`UPDATE crm_conversations SET customer_id = $2 WHERE id = $1`, [conversationId, customerId]);
  }
  await pg.query(
    `INSERT INTO crm_lead_assignments (conversation_id, staff_id, role, source, customer_state)
     VALUES ($1, $2, $3, 'auto', $4)`,
    [conversationId, staff.id, role, customerState]
  );

  logger.info({ conv_id: conversationId, staff: staff.username, role, customerState, open_load: staff.open_convs },
    '[leadDist] assigned');
  return { assigned: true, staff_id: staff.id, staff_username: staff.username, role, customer_state: customerState };
}

async function manualAssign(conversationId, staffId, byStaffId) {
  const r = await pg.query(`SELECT role FROM staff_users WHERE id = $1`, [staffId]);
  const role = r.rows[0]?.role || null;
  await pg.query(`UPDATE crm_conversations SET assigned_staff_id = $2 WHERE id = $1`, [conversationId, staffId]);
  await pg.query(
    `INSERT INTO crm_lead_assignments (conversation_id, staff_id, role, source, assigned_by)
     VALUES ($1, $2, $3, 'manual', $4)`,
    [conversationId, staffId, role, byStaffId]
  );
  return { assigned: true, staff_id: staffId, role };
}

module.exports = { distribute, manualAssign, lookupCustomerByPhone, pickLeastBusyStaff };
