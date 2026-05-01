const pg = require('../db/postgres');
const mysql = require('../db/mysql');

// ── Validation ───────────────────────────────────────────────────────────────

const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|replace|rename|call|lock|unlock|set\s+(?!@))\b/i;
const PARAM_RE = /:([a-zA-Z][a-zA-Z0-9_]{0,63})/g;

function validateSqlText(sql) {
  const trimmed = String(sql || '').trim();
  if (!trimmed) return 'sql_text empty';
  if (!/^select\s/i.test(trimmed)) return 'must start with SELECT';
  // Strip block + line comments before forbidden-keyword check
  const stripped = trimmed.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
  if (FORBIDDEN.test(stripped)) return 'forbidden keyword detected (only read-only SELECT allowed)';
  // Disallow multiple statements (allow single trailing semicolon, no internal ones)
  const noTrailingSemi = stripped.replace(/;\s*$/, '');
  if (noTrailingSemi.includes(';')) return 'multiple statements not allowed';
  return null;
}

function validateParamsSchema(params) {
  if (!Array.isArray(params)) return 'params must be an array';
  for (const p of params) {
    if (!p || typeof p !== 'object') return 'each param must be an object';
    if (!p.name || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name)) return `invalid param name: ${p.name}`;
    if (p.type && !['string', 'integer', 'number'].includes(p.type)) return `invalid param type: ${p.type}`;
  }
  return null;
}

function extractParamNames(sql) {
  const out = new Set();
  let m;
  while ((m = PARAM_RE.exec(sql)) !== null) out.add(m[1]);
  return Array.from(out);
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

async function listAll() {
  const { rows } = await pg.query(
    `SELECT id, name, description, params, sql_text, enabled, row_limit, created_at, updated_at
     FROM crm_sql_queries ORDER BY name ASC`
  );
  return rows;
}

async function listEnabled() {
  const { rows } = await pg.query(
    `SELECT id, name, description, params, sql_text, row_limit
     FROM crm_sql_queries WHERE enabled = TRUE ORDER BY name ASC`
  );
  return rows;
}

async function getByName(name) {
  const { rows } = await pg.query(
    `SELECT id, name, description, params, sql_text, enabled, row_limit
     FROM crm_sql_queries WHERE name = $1`,
    [name]
  );
  return rows[0] || null;
}

async function create({ name, description, params, sql_text, row_limit, created_by }) {
  const sqlErr = validateSqlText(sql_text);
  if (sqlErr) throw new Error(sqlErr);
  const paramsErr = validateParamsSchema(params);
  if (paramsErr) throw new Error(paramsErr);
  const limit = clampRowLimit(row_limit);

  const { rows } = await pg.query(
    `INSERT INTO crm_sql_queries (name, description, params, sql_text, row_limit, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, description, JSON.stringify(params || []), sql_text, limit, created_by || null]
  );
  return rows[0];
}

async function update(id, fields) {
  const allowed = ['name', 'description', 'params', 'sql_text', 'enabled', 'row_limit'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    if (k === 'sql_text') {
      const err = validateSqlText(fields[k]);
      if (err) throw new Error(err);
    }
    if (k === 'params') {
      const err = validateParamsSchema(fields[k]);
      if (err) throw new Error(err);
    }
    if (k === 'row_limit') fields[k] = clampRowLimit(fields[k]);

    vals.push(k === 'params' ? JSON.stringify(fields[k]) : fields[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return false;
  vals.push(id);
  await pg.query(
    `UPDATE crm_sql_queries SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`,
    vals
  );
  return true;
}

async function remove(id) {
  await pg.query(`DELETE FROM crm_sql_queries WHERE id = $1`, [id]);
}

function clampRowLimit(n) {
  const v = parseInt(n);
  if (!Number.isFinite(v) || v < 1) return 20;
  return Math.min(v, 100);
}

// ── Execution ────────────────────────────────────────────────────────────────

function buildBindings(query, paramValues) {
  // Replace :name occurrences with `?` and collect values in order.
  const values = [];
  const sql = query.sql_text.replace(PARAM_RE, (_match, name) => {
    const def = (query.params || []).find((p) => p.name === name);
    let val = paramValues?.[name];
    if (val === undefined || val === null || val === '') {
      if (def?.required) throw new Error(`param "${name}" is required`);
      val = null;
    } else if (def?.type === 'integer') {
      val = parseInt(val);
      if (!Number.isFinite(val)) throw new Error(`param "${name}" must be integer`);
    } else if (def?.type === 'number') {
      val = parseFloat(val);
      if (!Number.isFinite(val)) throw new Error(`param "${name}" must be number`);
    } else {
      val = String(val);
    }
    values.push(val);
    return '?';
  });
  return { sql, values };
}

function ensureLimit(sql, rowLimit) {
  // If query already has LIMIT, keep it (admin presumably set it intentionally).
  // Otherwise inject LIMIT N to enforce safety.
  if (/\blimit\s+\d+/i.test(sql)) return sql;
  return `${sql.replace(/;\s*$/, '')} LIMIT ${rowLimit}`;
}

async function run(name, paramValues = {}) {
  const query = await getByName(name);
  if (!query) throw new Error(`query "${name}" not found`);
  if (!query.enabled) throw new Error(`query "${name}" is disabled`);

  const { sql, values } = buildBindings(query, paramValues);
  const finalSql = ensureLimit(sql, query.row_limit);
  const [rows] = await mysql.query(finalSql, values);
  return {
    name,
    row_count: rows.length,
    rows: rows.slice(0, query.row_limit),
    truncated: rows.length >= query.row_limit,
  };
}

module.exports = {
  validateSqlText,
  validateParamsSchema,
  extractParamNames,
  listAll, listEnabled, getByName, create, update, remove,
  buildBindings, ensureLimit, run,
};
