'use strict';
/**
 * orderMatch.js
 * Resolve whether a WhatsApp lead "closed" — i.e. the customer's phone has a
 * real order in the POS (MySQL lavender_lavenderPOS).
 *
 * "Closing" = the phone matches a customer with >= 1 order whose status is NOT
 * 'cancelled' (approved + unapproved both count; cancelled does not).
 *
 * Phone matching: 96% of POS phones are clean `62...`, Lotus uses `628...`.
 * We normalize both sides to the last 10 digits (drops the `62`/`0`/`+62`
 * country prefixes consistently) and compare. Validated against known
 * closing pairs (e.g. 6281188800067 -> order 3370862606185802106).
 *
 * Exports:
 *   normalizePhone(p)                -> string|null   (pure, last 10 digits)
 *   getClosingPhoneSet(phones[])     -> Promise<Set<string>>  normalized phones that closed
 *   isClosingPhone(phone)            -> Promise<boolean>
 */

const mysql = require('../db/mysql');

// Order states that count as "the lead closed". Tweak here if the business
// definition changes (e.g. add a paid-only mode).
const CLOSING_STATUS_SQL = `o.status <> 'cancelled'`;

/** Normalize any phone string to its last 10 digits, or null if too short. */
function normalizePhone(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

/**
 * Given an array of raw phone strings, return the Set of *normalized* phones
 * that have at least one non-cancelled order. Batched in one query.
 * @param {string[]} phones
 * @returns {Promise<Set<string>>}
 */
async function getClosingPhoneSet(phones) {
  const normed = [...new Set((phones || []).map(normalizePhone).filter(Boolean))];
  if (!normed.length) return new Set();

  const placeholders = normed.map(() => '?').join(',');
  const [rows] = await mysql.query(
    `SELECT DISTINCT RIGHT(REGEXP_REPLACE(c.phone,'[^0-9]',''),10) AS np
       FROM customer c
       JOIN \`order\` o ON o.customer_id = c.id AND ${CLOSING_STATUS_SQL}
      WHERE RIGHT(REGEXP_REPLACE(c.phone,'[^0-9]',''),10) IN (${placeholders})`,
    normed
  );
  return new Set(rows.map(r => r.np));
}

/** True if a single phone closed (has a non-cancelled order). */
async function isClosingPhone(phone) {
  const set = await getClosingPhoneSet([phone]);
  const n = normalizePhone(phone);
  return n != null && set.has(n);
}

module.exports = { normalizePhone, getClosingPhoneSet, isClosingPhone, CLOSING_STATUS_SQL };
