const express = require('express');
const pg = require('../db/postgres');
const { verifyWebhookSecret } = require('../middleware/webhookAuth');
const { resolveByPhone } = require('../services/contactResolver');
const waClient = require('../services/waClient');
const settings = require('../services/settings');
const { downloadAndSave, attachmentTypeFor } = require('../services/uploadService');

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
    const session = parsed.session || process.env.WAHA_SESSION || null;

    const convQ = await client.query(
      `INSERT INTO crm_conversations (phone, customer_id, last_message_at, shadow_mode, wa_session, push_name)
       VALUES ($1, $2, now(), $3, $4, $5)
       ON CONFLICT (phone) DO UPDATE SET
         last_message_at = now(),
         customer_id = COALESCE(crm_conversations.customer_id, EXCLUDED.customer_id),
         wa_session = COALESCE(EXCLUDED.wa_session, crm_conversations.wa_session),
         push_name = COALESCE(EXCLUDED.push_name, crm_conversations.push_name),
         updated_at = now()
       RETURNING id, ai_enabled, ai_paused_until, status, shadow_mode, wa_session`,
      [parsed.phone, resolved.customer_id, shadowDefault, session, parsed.pushName || null]
    );
    const conv = convQ.rows[0];

    // Pass through the actual media type (image / video / audio / document / media);
    // fall back to 'text' when no attachment.
    let msgType = parsed.type && parsed.type !== 'text' ? parsed.type : 'text';
    let attachmentUrl = parsed.mediaUrl || null;

    // WAHA hosts the media on its internal /tmp dir which gets cleaned up.
    // Mirror it to our uploads/ NOW so the file is retained even if WAHA evicts.
    if (attachmentUrl) {
      try {
        const saved = await downloadAndSave(attachmentUrl, { mimetype: parsed.mediaMime });
        attachmentUrl = saved.publicUrl;
        if (msgType === 'text' || msgType === 'media') {
          msgType = attachmentTypeFor(saved.mimetype);
        }
      } catch (err) {
        console.error('[webhook/waha] media download failed:', err.message);
        // Keep original URL — UI fallback will show "image gagal load"
      }
    }

    const msgQ = await client.query(
      `INSERT INTO crm_messages
         (conversation_id, direction, sender_type, waha_message_id, body, message_type, attachment_url)
       VALUES ($1, 'in', 'customer', $2, $3, $4, $5)
       RETURNING id, created_at`,
      [conv.id, parsed.wahaMessageId, parsed.body, msgType, attachmentUrl]
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
    // PG 23505 = unique_violation. Happens when WAHA delivers the same webhook
    // event twice in parallel (e.g., subscribed to both `message` and `message.any`).
    // The first insert wins; treat the second as a duplicate not an error.
    if (err && err.code === '23505') {
      return res.json({ success: true, duplicate: true, message: 'race-on-unique' });
    }
    console.error('[webhook/waha]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
