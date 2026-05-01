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
  await pg.query(
    `INSERT INTO crm_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), staffId || null]
  );
  invalidateCache();
}

async function listSettings() {
  const { rows } = await pg.query(
    `SELECT key, value, updated_at, updated_by FROM crm_settings ORDER BY key`
  );
  return rows;
}

module.exports = { getSetting, setSetting, listSettings, invalidateCache };
