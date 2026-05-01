const express = require('express');
const { requireAdmin } = require('../middleware/requireAdmin');
const wahaAdmin = require('../services/wahaAdmin');
const logger = require('../services/logger');

const router = express.Router();
router.use(requireAdmin);

function surfaceUpstream(res, r, fallbackMsg) {
  const detail = (r.data && r.data.message) || r.data || fallbackMsg;
  return res.status(502).json({
    success: false,
    upstream_status: r.status,
    message: typeof detail === 'string' ? detail : fallbackMsg,
  });
}

router.get('/sessions', async (_req, res) => {
  const r = await wahaAdmin.listSessions();
  if (!r.ok) return surfaceUpstream(res, r, 'WAHA list failed');
  res.json({ success: true, sessions: r.data });
});

router.get('/sessions/:name', async (req, res) => {
  const r = await wahaAdmin.getSessionDetails(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'WAHA details failed');
  res.json({ success: true, session: r.data });
});

router.post('/sessions', async (req, res) => {
  const name = (req.body?.name || '').toString().trim();
  if (!wahaAdmin.isValidSessionName(name)) {
    return res.status(400).json({ success: false, message: 'invalid session name (2-64 chars, [a-zA-Z0-9_-])' });
  }
  const create = await wahaAdmin.createSession(name);
  if (!create.ok) return surfaceUpstream(res, create, 'WAHA create failed');
  const start = await wahaAdmin.startSession(name);
  if (!start.ok && start.status !== 422) {
    return surfaceUpstream(res, start, 'WAHA start failed');
  }
  logger.info({ name }, '[wahaAdmin] session created+started');
  res.json({ success: true, session: create.data });
});

router.post('/sessions/:name/start', async (req, res) => {
  const r = await wahaAdmin.startSession(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'start failed');
  res.json({ success: true });
});

router.post('/sessions/:name/stop', async (req, res) => {
  const r = await wahaAdmin.stopSession(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'stop failed');
  res.json({ success: true });
});

router.post('/sessions/:name/restart', async (req, res) => {
  const r = await wahaAdmin.restartSession(req.params.name);
  if (!r.ok) return surfaceUpstream(res, r, 'restart failed');
  res.json({ success: true });
});

router.delete('/sessions/:name', async (req, res) => {
  const name = req.params.name;
  const activeName = process.env.WAHA_SESSION;
  if (activeName && name === activeName) {
    return res.status(409).json({
      success: false,
      message: `Refused: "${name}" is the active session for the AI agent (WAHA_SESSION). Edit .env and restart backend before deleting.`,
    });
  }
  const r = await wahaAdmin.deleteSession(name);
  if (!r.ok) return surfaceUpstream(res, r, 'delete failed');
  res.json({ success: true });
});

router.get('/sessions/:name/qr', async (req, res) => {
  const r = await wahaAdmin.getSessionQr(req.params.name);
  if (!r.ok) {
    if (r.status === 422 || (r.detail || '').toString().match(/SCAN_QR_CODE/i)) {
      return res.status(409).json({
        success: false,
        message: 'Session not in SCAN_QR_CODE state. Stop+restart it to regenerate, or it may already be authenticated.',
        upstream_status: r.status,
      });
    }
    return res.status(502).json({
      success: false,
      upstream_status: r.status,
      message: 'WAHA QR endpoint failed',
    });
  }
  res.set('Content-Type', r.contentType || 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(r.body);
});

module.exports = router;
