// Vonage Messages API webhooks (inbound + status).
// Configure in Vonage Dashboard → Application → Messages:
//   Inbound URL: https://salesai.prestisa.net/webhook/vonage/inbound
//   Status URL:  https://salesai.prestisa.net/webhook/vonage/status
// Vonage signs requests with HMAC-SHA256 (signature_secret) when configured —
// optional verification toggled via VONAGE_SIGNATURE_SECRET.
const crypto = require('crypto');
const express = require('express');
const pg = require('../db/postgres');
const vonageAdapter = require('../services/waAdapters/vonageAdapter');
const { resolveByPhone } = require('../services/contactResolver');
const { downloadAndSave, attachmentTypeFor } = require('../services/uploadService');

const router = express.Router();

function verifyVonageSignature(req, _res, next) {
  const secret = process.env.VONAGE_SIGNATURE_SECRET;
  if (!secret) return next(); // verification disabled
  const sig = req.header('X-Vonage-Signature') || '';
  const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (sig !== expected) {
    return _res.status(401).json({ success: false, message: 'invalid signature' });
  }
  next();
}

// Inbound — customer → us
router.post('/inbound', verifyVonageSignature, async (req, res) => {
  const parsed = vonageAdapter.parseInbound(req.body || {});
  if (parsed.skip) {
    return res.json({ success: true, skipped: parsed.skip });
  }
  if (!parsed.phone) {
    return res.status(400).json({ success: false, message: 'phone missing' });
  }

  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    // Dedup by Vonage message_uuid (stored in waha_message_id column for shared schema)
    if (parsed.wahaMessageId) {
      const existing = await client.query(
        `SELECT id, conversation_id FROM crm_messages WHERE waha_message_id = $1`,
        [parsed.wahaMessageId]
      );
      if (existing.rowCount > 0) {
        await client.query('COMMIT');
        return res.json({ success: true, duplicate: true,
          message_id: existing.rows[0].id, conversation_id: existing.rows[0].conversation_id });
      }
    }

    const resolved = await resolveByPhone(parsed.phone);

    const convQ = await client.query(
      `INSERT INTO crm_conversations (phone, customer_id, last_message_at, wa_session, push_name)
       VALUES ($1, $2, now(), 'vonage', $3)
       ON CONFLICT (phone) DO UPDATE SET
         last_message_at = now(),
         customer_id = COALESCE(crm_conversations.customer_id, EXCLUDED.customer_id),
         wa_session = COALESCE(crm_conversations.wa_session, EXCLUDED.wa_session),
         push_name = COALESCE(EXCLUDED.push_name, crm_conversations.push_name),
         updated_at = now()
       RETURNING id, ai_enabled, ai_paused_until, status, shadow_mode, wa_session`,
      [parsed.phone, resolved.customer_id, parsed.pushName || null]
    );
    const conv = convQ.rows[0];

    let msgType = parsed.type && parsed.type !== 'text' ? parsed.type : 'text';
    let attachmentUrl = parsed.mediaUrl || null;
    if (attachmentUrl) {
      try {
        const saved = await downloadAndSave(attachmentUrl, { mimetype: parsed.mediaMime });
        attachmentUrl = saved.publicUrl;
        if (msgType === 'text' || msgType === 'media') {
          msgType = attachmentTypeFor(saved.mimetype);
        }
      } catch (err) {
        console.error('[webhook/vonage] media download failed:', err.message);
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
      `UPDATE crm_conversations SET first_inbound_at = COALESCE(first_inbound_at, $2) WHERE id = $1`,
      [conv.id, msg.created_at]
    );

    // Queue for AI (debounced like waha)
    const debounceSec = parseInt(process.env.INBOUND_DEBOUNCE_SEC) || 10;
    await client.query(
      `INSERT INTO crm_inbound_queue (message_id, conversation_id, process_after)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [msg.id, conv.id, String(debounceSec)]
    );
    await client.query(
      `UPDATE crm_inbound_queue SET process_after = now() + ($2 || ' seconds')::interval
       WHERE conversation_id = $1 AND status = 'pending'`,
      [conv.id, String(debounceSec)]
    );

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      io.to(`crm:conv:${conv.id}`).emit('crm:message', {
        conversation_id: conv.id,
        message: {
          id: msg.id, direction: 'in', sender_type: 'customer',
          body: parsed.body, message_type: msgType,
          attachment_url: attachmentUrl, created_at: msg.created_at,
        },
      });
      io.to('crm:inbox').emit('crm:conv-updated', { conversation_id: conv.id });
    }
    res.json({ success: true, conversation_id: conv.id, message_id: msg.id });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err && err.code === '23505') {
      return res.json({ success: true, duplicate: true });
    }
    console.error('[webhook/vonage/inbound]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Status — delivery receipts (sent / delivered / read / rejected)
router.post('/status', verifyVonageSignature, async (req, res) => {
  const b = req.body || {};
  const uuid = b.message_uuid;
  const status = b.status; // submitted | delivered | read | rejected | undeliverable
  if (!uuid) return res.json({ success: true, ignored: 'no-uuid' });
  try {
    const map = { submitted: 'sent', delivered: 'delivered', read: 'read',
                  rejected: 'failed', undeliverable: 'failed' };
    const dbStatus = map[status] || status;
    await pg.query(
      `UPDATE crm_messages SET send_status = $2 WHERE waha_message_id = $1`,
      [uuid, dbStatus]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[webhook/vonage/status]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
