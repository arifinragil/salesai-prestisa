// Customer Portal Issues — proxy to customer-dashboard with bearer token.
// Mounted at /api/customer-issues. Re-uses CRM JWT cookie for auth.
const express = require('express');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();

const PORTAL_URL   = process.env.CUSTOMER_PORTAL_URL   || 'https://customer.krttpt.site';
const PORTAL_TOKEN = process.env.CUSTOMER_PORTAL_TOKEN || '';

async function portalFetch(path, opts = {}) {
  const res = await fetch(PORTAL_URL + path, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${PORTAL_TOKEN}`,
      'Content-Type':  'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* noop */ }
  return { status: res.status, body: json ?? { success: false, message: text } };
}

// All endpoints require an authenticated CRM staff user.
router.use(requireStaff);

// GET /api/customer-issues?status=open
router.get('/', async (req, res) => {
  if (!PORTAL_TOKEN) return res.status(500).json({ success: false, message: 'CUSTOMER_PORTAL_TOKEN belum diset.' });
  const qs = new URLSearchParams();
  if (req.query.status) qs.set('status', String(req.query.status));
  if (req.query.limit)  qs.set('limit',  String(req.query.limit));
  const r = await portalFetch(`/api/crm/issues?${qs.toString()}`);
  return res.status(r.status).json(r.body);
});

// GET /api/customer-issues/:id
router.get('/:id', async (req, res) => {
  if (!PORTAL_TOKEN) return res.status(500).json({ success: false, message: 'CUSTOMER_PORTAL_TOKEN belum diset.' });
  const r = await portalFetch(`/api/crm/issues/${encodeURIComponent(req.params.id)}`);
  return res.status(r.status).json(r.body);
});

// POST /api/customer-issues/:id  body: { message }
router.post('/:id', async (req, res) => {
  if (!PORTAL_TOKEN) return res.status(500).json({ success: false, message: 'CUSTOMER_PORTAL_TOKEN belum diset.' });
  const { message } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: 'Pesan wajib diisi.' });
  }
  const r = await portalFetch(`/api/crm/issues/${encodeURIComponent(req.params.id)}`, {
    method: 'POST',
    body: { senderName: req.user?.username || 'CRM', message },
  });
  return res.status(r.status).json(r.body);
});

// PATCH /api/customer-issues/:id  body: { status }
router.patch('/:id', async (req, res) => {
  if (!PORTAL_TOKEN) return res.status(500).json({ success: false, message: 'CUSTOMER_PORTAL_TOKEN belum diset.' });
  const { status } = req.body || {};
  if (status !== 'open' && status !== 'closed') {
    return res.status(400).json({ success: false, message: 'status harus open/closed.' });
  }
  const r = await portalFetch(`/api/crm/issues/${encodeURIComponent(req.params.id)}`, {
    method: 'PATCH',
    body: { status },
  });
  return res.status(r.status).json(r.body);
});

module.exports = router;
