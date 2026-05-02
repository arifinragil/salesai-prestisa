// backend/routes/suggestions.js
// REST endpoints untuk co-pilot suggestion lifecycle.
// Mounted at /api/inbox/conversations/:id/suggestions (mergeParams: true).
const express = require('express');
const pg = require('../db/postgres');
const suggestionEngine = require('../services/suggestionEngine');
const { requireStaff } = require('../middleware/auth');
const notify = require('../services/notify');

const router = express.Router({ mergeParams: true });
router.use(requireStaff);

// GET latest suggestion for a conversation (most recent inbound)
router.get('/latest', async (req, res) => {
  const convId = parseInt(req.params.id);
  if (!Number.isFinite(convId)) return res.status(400).json({ error: 'bad_conv_id' });
  const r = await pg.query(
    `SELECT id, options, generation_ms, shown_at, picked_rank, usage_type, regen_count
     FROM crm_suggestion_log
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  if (!r.rows[0]) return res.json({ suggestion: null });
  res.json({ suggestion: r.rows[0] });
});

// POST generate a fresh suggestion for the latest inbound (on-demand, copilot mode).
// Operator-triggered; no auto-generate to save tokens. Returns the new log.
router.post('/generate', async (req, res) => {
  const convId = parseInt(req.params.id);
  if (!Number.isFinite(convId)) return res.status(400).json({ error: 'bad_conv_id' });

  const msgQ = await pg.query(
    `SELECT id, body FROM crm_messages
     WHERE conversation_id = $1 AND direction = 'in'
     ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  const msg = msgQ.rows[0];
  if (!msg) return res.status(404).json({ error: 'no_inbound' });

  const ic = await pg.query(`SELECT last_intent FROM crm_conversations WHERE id = $1`, [convId]);
  const out = await suggestionEngine.generate({
    conversationId: convId,
    inboundMsgId: msg.id,
    inboundBody: msg.body,
    intent: ic.rows[0]?.last_intent || null,
  });

  const io = notify.getIO?.();
  if (io) io.to(`crm:conv:${convId}`).emit('suggestion:new', { conversation_id: convId, ...out });
  res.json(out);
});

// POST regenerate the latest suggestion (rate-limited)
router.post('/regenerate', async (req, res) => {
  const convId = parseInt(req.params.id);
  const r = await pg.query(
    `SELECT id, inbound_msg_id, regen_count FROM crm_suggestion_log
     WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
    [convId]
  );
  const log = r.rows[0];
  if (!log) return res.status(404).json({ error: 'no_suggestion' });
  if (log.regen_count >= 3) return res.status(429).json({ error: 'regen_limit', regen_count: log.regen_count });

  const msgQ = await pg.query(`SELECT id, body FROM crm_messages WHERE id = $1`, [log.inbound_msg_id]);
  const msg = msgQ.rows[0];
  if (!msg) return res.status(404).json({ error: 'inbound_msg_missing' });

  // Reuse the intent classifier output from the original generation so case
  // ranking stays stable across regenerates (otherwise the top 3 reshuffle).
  const ic = await pg.query(`SELECT last_intent FROM crm_conversations WHERE id = $1`, [convId]);
  const out = await suggestionEngine.generate({
    conversationId: convId,
    inboundMsgId: msg.id,
    inboundBody: msg.body,
    intent: ic.rows[0]?.last_intent || null,
    regen: true,
    regenLogId: log.id,
  });

  const io = notify.getIO?.();
  if (io) io.to(`crm:conv:${convId}`).emit('suggestion:new', { conversation_id: convId, ...out });
  res.json(out);
});

// POST mark suggestion as used
router.post('/:logId/use', async (req, res) => {
  const convId = parseInt(req.params.id);
  const logId = parseInt(req.params.logId);
  if (!Number.isFinite(convId) || !Number.isFinite(logId)) return res.status(400).json({ error: 'bad_params' });
  const { picked_rank, sent_text, sent_msg_id } = req.body || {};
  const staffId = req.staff?.staff_id || null;

  // Bind logId to the URL's conv id — prevents cross-conv tampering.
  const cur = await pg.query(
    `SELECT options, shown_at, conversation_id FROM crm_suggestion_log WHERE id = $1 AND conversation_id = $2`,
    [logId, convId]
  );
  const log = cur.rows[0];
  if (!log) return res.status(404).json({ error: 'log_not_found' });

  let usageType = 'manual';
  let editDistance = null;
  if (picked_rank) {
    const opt = (log.options || []).find((o) => o.rank === picked_rank);
    if (opt && opt.text) {
      const d = normLevenshtein(opt.text, sent_text || '');
      editDistance = Number(d.toFixed(3));
      usageType = editDistance < 0.05 ? 'raw' : 'edited';
    }
  }
  const pickLatencyMs = Date.now() - new Date(log.shown_at).getTime();
  await pg.query(
    `UPDATE crm_suggestion_log
     SET picked_rank = $1, usage_type = $2, sent_msg_id = $3,
         staff_id = $4, pick_latency_ms = $5, edit_distance = $6
     WHERE id = $7 AND conversation_id = $8`,
    [picked_rank || null, usageType, sent_msg_id || null, staffId, pickLatencyMs, editDistance, logId, convId]
  );

  const io = notify.getIO?.();
  if (io) {
    io.to(`crm:conv:${log.conversation_id}`).emit('suggestion:used', {
      log_id: logId, picked_rank, usage_type: usageType, staff_id: staffId,
    });
  }
  res.json({ ok: true, usage_type: usageType, edit_distance: editDistance, pick_latency_ms: pickLatencyMs });
});

// POST flag suggestion
router.post('/:logId/flag', async (req, res) => {
  const convId = parseInt(req.params.id);
  const logId = parseInt(req.params.logId);
  if (!Number.isFinite(convId) || !Number.isFinite(logId)) return res.status(400).json({ error: 'bad_params' });
  const { reason, note } = req.body || {};
  const allowed = ['off_tone', 'wrong', 'irrelevant', 'harmful'];
  if (!allowed.includes(reason)) return res.status(400).json({ error: 'bad_reason' });
  const r = await pg.query(
    `UPDATE crm_suggestion_log SET flagged_reason = $1, flagged_note = $2
     WHERE id = $3 AND conversation_id = $4`,
    [reason, note || null, logId, convId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'log_not_found' });
  res.json({ ok: true });
});

// Normalized Levenshtein (0..1). 0 = identical, 1 = totally different.
function normLevenshtein(a, b) {
  if (!a && !b) return 0;
  if (!a || !b) return 1;
  const m = a.length, n = b.length;
  if (Math.max(m, n) === 0) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n] / Math.max(m, n);
}

module.exports = router;
