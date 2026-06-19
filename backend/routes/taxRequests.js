// Tax Invoice Requests — proxy to customer-dashboard with bearer token.
// Mounted at /api/tax-requests. Re-uses CRM JWT cookie for auth.
const express = require('express');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();

const PORTAL_URL   = process.env.CUSTOMER_PORTAL_URL   || 'https://customer.prestisa.net';
const PORTAL_TOKEN = process.env.CUSTOMER_PORTAL_TOKEN || '';

async function portalFetch(path, opts = {}) {
  const res = await fetch(PORTAL_URL + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${PORTAL_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: res.status, body: json ?? { success: false, message: text } };
}

router.use(requireStaff);

// GET /api/tax-requests?status=requested
router.get('/', async (req, res) => {
  if (!PORTAL_TOKEN) return res.status(500).json({ success: false, message: 'CUSTOMER_PORTAL_TOKEN belum diset.' });
  const qs = new URLSearchParams();
  if (req.query.status) qs.set('status', String(req.query.status));
  if (req.query.limit)  qs.set('limit',  String(req.query.limit));
  const r = await portalFetch(`/api/crm/tax-requests?${qs.toString()}`);
  return res.status(r.status).json(r.body);
});

// PATCH /api/tax-requests/:id  body: { status, notes }
router.patch('/:id', async (req, res) => {
  if (!PORTAL_TOKEN) return res.status(500).json({ success: false, message: 'CUSTOMER_PORTAL_TOKEN belum diset.' });
  const { status, notes } = req.body || {};
  const r = await portalFetch(`/api/crm/tax-requests`, {
    method: 'PATCH',
    body: { id: Number(req.params.id), status, notes },
  });
  return res.status(r.status).json(r.body);
});

module.exports = router;
