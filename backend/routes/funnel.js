// Public funnel-tracking endpoint. Order form (or thank-you page) calls
// POST /api/funnel/event with { ref, event } when:
//   - ref param appears in URL → 'click'  (optional; could be done by frontend)
//   - form is loaded → 'form_loaded'
//   - form is submitted → 'submitted'
// Conversion to 'paid' is read from MySQL `order` table.
const express = require('express');
const pg = require('../db/postgres');
const router = express.Router();

const ALLOWED = new Set(['click', 'form_loaded', 'submitted']);

router.post('/event', async (req, res) => {
  const { ref, event } = req.body || {};
  if (!ref || !ALLOWED.has(event)) {
    return res.status(400).json({ success: false, message: 'ref + event(click|form_loaded|submitted) required' });
  }
  const refStr = String(ref).slice(0, 64);
  // Look up conversation_id by ref
  const c = await pg.query(`SELECT id FROM crm_conversations WHERE last_order_url_ref = $1 LIMIT 1`, [refStr]);
  const convId = c.rows[0]?.id || null;
  await pg.query(
    `INSERT INTO crm_link_events (conversation_id, ref, event, source_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [convId, refStr, event, req.ip || null, (req.get('user-agent') || '').slice(0, 300)]
  );

  // Pipeline: form_submitted → order_submitted (only for 'submitted' event)
  if (event === 'submitted' && convId) {
    try {
      const engine = require('../services/pipelineEngine');
      let orderId = null, value = null;
      try {
        const mysql = require('../db/mysql');
        const [orders] = await mysql.query(
          `SELECT id, total FROM \`order\` WHERE utm_content = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
          [refStr]
        );
        if (orders[0]) {
          orderId = orders[0].id;
          value = Number(orders[0].total) || null;
        }
      } catch {}
      if (orderId) await engine.fillFromOrder(pg, convId, orderId, value);
      await engine.apply(pg, convId, { type: 'order_submitted' }, {
        source: 'auto:funnel_submitted',
        metadata: { ref: refStr, order_id: orderId, value },
      });
    } catch (err) {
      console.warn('[pipeline] funnel hook failed:', err.message);
    }
  }

  res.json({ success: true });
});

module.exports = router;
