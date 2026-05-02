const pg = require('../db/postgres');

// In-memory cache to avoid hitting PG on every aiAgent tick / webhook.
// Cache invalidated on PUT or after TTL expires.
const TTL_MS = 30_000;
let cache = new Map(); // key -> { value, expiresAt }

function _cacheGet(key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.value;
}

function _cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function invalidateCache() { cache = new Map(); }

async function getSetting(key, fallback) {
  const cached = _cacheGet(key);
  if (cached !== undefined) return cached;
  const { rows } = await pg.query(`SELECT value FROM crm_settings WHERE key = $1`, [key]);
  if (!rows[0]) {
    _cacheSet(key, fallback);
    return fallback;
  }
  _cacheSet(key, rows[0].value);
  return rows[0].value;
}

async function setSetting(key, value, staffId) {
  // Capture old value first for audit
  let oldVal = null;
  try {
    const prev = await pg.query(`SELECT value FROM crm_settings WHERE key = $1`, [key]);
    if (prev.rows[0]) oldVal = prev.rows[0].value;
  } catch {}
  await pg.query(
    `INSERT INTO crm_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), staffId || null]
  );
  invalidateCache();
  // Best-effort audit (don't bubble errors)
  try {
    // Mask sensitive credential values before logging
    const masked = key === 'ai_credentials' || key.includes('token') || key.includes('key')
      ? '"***masked***"' : JSON.stringify(value);
    const oldMasked = key === 'ai_credentials' || key.includes('token') || key.includes('key')
      ? '"***masked***"' : JSON.stringify(oldVal);
    await pg.query(
      `INSERT INTO crm_settings_audit (key, old_value, new_value, staff_id)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
      [key, oldMasked, masked, staffId || null]
    );
  } catch {}
}

async function listAudit(limit = 100) {
  const { rows } = await pg.query(
    `SELECT a.id, a.key, a.old_value, a.new_value, a.created_at, a.staff_id, u.username, u.full_name
     FROM crm_settings_audit a LEFT JOIN staff_users u ON u.id = a.staff_id
     ORDER BY a.id DESC LIMIT $1`, [limit]
  );
  return rows;
}

async function listSettings() {
  const { rows } = await pg.query(
    `SELECT key, value, updated_at, updated_by FROM crm_settings ORDER BY key`
  );
  return rows;
}

module.exports = { getSetting, setSetting, listSettings, listAudit, invalidateCache };
