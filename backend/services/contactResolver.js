const mysql = require('../db/mysql');

function digitsOnly(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\D/g, '');
}

function normalizePhone(raw) {
  let p = digitsOnly(raw);
  if (!p) return null;
  if (p.startsWith('0')) p = '62' + p.slice(1);
  else if (p.startsWith('8')) p = '62' + p;
  return p;
}

function jidToPhone(jid) {
  if (!jid) return null;
  const head = String(jid).split('@')[0];
  return normalizePhone(head);
}

async function resolveByPhone(phone) {
  const empty = { customer_id: null, name: null };
  if (!phone) return empty;
  const tail = phone.slice(-10);
  if (tail.length < 9) return empty;
  const [rows] = await mysql.query(
    `SELECT id, name FROM customer
     WHERE deleted_at IS NULL
       AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10) = ?
     ORDER BY id DESC
     LIMIT 1`,
    [tail]
  );
  if (!rows[0]) return empty;
  return { customer_id: rows[0].id, name: rows[0].name };
}

module.exports = { digitsOnly, normalizePhone, jidToPhone, resolveByPhone };
