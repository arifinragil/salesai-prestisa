'use strict';
/**
 * routes/penyebab.js
 * Mount: app.use('/api/penyebab', require('./routes/penyebab'))
 *
 * GET  /analysis?from&to          — aggregate crm_lead_penyebab (any staff)
 * POST /:lotus_id/analyze         — run analysis for one lead (admin only)
 * POST /bulk-analyze              — run analysis for many leads (admin only)
 */

const express = require('express');
const router = express.Router();
const { requireStaff } = require('../middleware/auth');
const pg = require('../db/postgres');
const { aggregate } = require('../services/penyebabAggregate');
const { analyzeLead } = require('../services/penyebabAnalyze');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// All routes require a logged-in staff member
router.use(requireStaff);

// ── GET /analysis ─────────────────────────────────────────────────────────────

router.get('/analysis', async (req, res, next) => {
  try {
    const { from, to } = req.query;

    let whereClause = '';
    const params = [];

    if (from || to) {
      // explicit range provided
      if (from) {
        params.push(from);
        whereClause += ` AND analyzed_at >= $${params.length}`;
      }
      if (to) {
        params.push(to);
        whereClause += ` AND analyzed_at <= $${params.length}`;
      }
    } else {
      // default: last 30 days
      whereClause = ' AND analyzed_at >= now() - interval \'30 days\'';
    }

    const sql = `
      SELECT lotus_id, cust_number, business_number,
             is_closing, churn, issue, sub_issue, rinci,
             penyebab_tidak_closing, analisa, analyzed_at
        FROM crm_lead_penyebab
       WHERE 1=1${whereClause}
       ORDER BY analyzed_at DESC
    `;

    const { rows } = await pg.query(sql, params);
    const result = aggregate(rows);

    res.json({ success: true, count: rows.length, ...result });
  } catch (err) {
    next(err);
  }
});

// ── POST /:lotus_id/analyze ───────────────────────────────────────────────────

router.post('/:lotus_id/analyze', async (req, res, next) => {
  if (req.staff?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }
  try {
    const row = await analyzeLead(req.params.lotus_id);
    res.json({ success: true, row });
  } catch (err) {
    next(err);
  }
});

// ── POST /bulk-analyze ────────────────────────────────────────────────────────

router.post('/bulk-analyze', async (req, res, next) => {
  if (req.staff?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }

  const { lotus_ids } = req.body ?? {};

  if (!Array.isArray(lotus_ids) || lotus_ids.length === 0) {
    return res.status(400).json({ success: false, message: 'lotus_ids must be a non-empty array' });
  }
  if (lotus_ids.length > 100) {
    return res.status(400).json({ success: false, message: 'lotus_ids exceeds max of 100' });
  }

  let processed = 0, succeeded = 0, failed = 0;
  const errors = [];

  for (const lotus_id of lotus_ids) {
    processed++;
    try {
      await analyzeLead(lotus_id);
      succeeded++;
    } catch (err) {
      failed++;
      errors.push({ lotus_id, error: err.message });
    }
    if (processed < lotus_ids.length) await sleep(200);
  }

  res.json({ success: true, processed, succeeded, failed, errors });
});

module.exports = router;
