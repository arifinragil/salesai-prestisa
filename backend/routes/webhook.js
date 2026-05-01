const express = require('express');
const pg = require('../db/postgres');
const { verifyWebhookSecret } = require('../middleware/webhookAuth');
const { resolveByPhone } = require('../services/contactResolver');
const waClient = require('../services/waClient');
const settings = require('../services/settings');

const router = express.Router();

router.post('/waha', verifyWebhookSecret, async (req, res) => {
  const parsed = waClient.parseInbound(req.body || {});

  if (parsed.skip) {
    return res.json({ success: true, skipped: parsed.skip });
  }
  if (!parsed.phone) {
    return res.status(400).json({ success: false, message: 'phone missing in payload' });
  }

  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    if (parsed.wahaMessageId) {
      const existing = await client.query(
        `SELECT id, conversation_id FROM crm_messages WHERE waha_message_id = $1`,
        [parsed.wahaMessageId]
      );
      if (existing.rowCount > 0) {
        await client.query('COMMIT');
        return res.json({
          success: true,
          duplicate: true,
          message_id: existing.rows[0].id,
          conversation_id: existing.rows[0].conversation_id,
        });
      }
    }

    const resolved = await resolveByPhone(parsed.phone);
    const shadowDefault = !!(await settings.getSetting('shadow_mode_default', false));

    const convQ = await client.query(
      `INSERT INTO crm_conversations (phone, customer_id, last_message_at, shadow_mode)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (phone) DO UPDATE SET
         last_message_at = now(),
         customer_id = COALESCE(crm_conversations.customer_id, EXCLUDED.customer_id),
         updated_at = now()
       RETURNING id, ai_enabled, ai_paused_until, status, shadow_mode`,
      [parsed.phone, resolved.customer_id, shadowDefault]
    );
    const conv = convQ.rows[0];

    const msgType = parsed.type === 'media' ? 'media' : 'text';
    const msgQ = await client.query(
      `INSERT INTO crm_messages
         (conversation_id, direction, sender_type, waha_message_id, body, message_type, attachment_url)
       VALUES ($1, 'in', 'customer', $2, $3, $4, $5)
       RETURNING id, created_at`,
      [conv.id, parsed.wahaMessageId, parsed.body, msgType, parsed.mediaUrl]
    );
    const msg = msgQ.rows[0];

    await client.query(
      `INSERT INTO crm_inbound_queue (message_id, conversation_id) VALUES ($1, $2)`,
      [msg.id, conv.id]
    );

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      io.to(`crm:conv:${conv.id}`).emit('crm:message', {
        conversation_id: conv.id,
        message: {
          id: msg.id,
          direction: 'in',
          sender_type: 'customer',
          body: parsed.body,
          message_type: msgType,
          attachment_url: parsed.mediaUrl,
          created_at: msg.created_at,
        },
      });
      io.to('crm:inbox').emit('crm:conv-updated', { conversation_id: conv.id });
    }

    res.json({
      success: true,
      conversation_id: conv.id,
      message_id: msg.id,
      ai_enabled: conv.ai_enabled,
      paused: !!conv.ai_paused_until,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[webhook/waha]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
