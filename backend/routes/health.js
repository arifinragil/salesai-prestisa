const express = require('express');
const pg = require('../db/postgres');
const mysql = require('../db/mysql');

const router = express.Router();

router.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

router.get('/readyz', async (_req, res) => {
  const out = { ok: true, postgres: false, mysql: false };
  try { await pg.query('SELECT 1'); out.postgres = true; } catch (err) { out.ok = false; out.postgres_error = err.message; }
  try { await mysql.query('SELECT 1'); out.mysql = true; } catch (err) { out.ok = false; out.mysql_error = err.message; }
  res.status(out.ok ? 200 : 503).json(out);
});

module.exports = router;
