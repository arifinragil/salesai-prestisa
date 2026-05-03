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
       RETURNING id, ai_enabled, ai_paused_until, status, shadow_mode, wa_session, (xmax = 0) AS is_new_conv`,
      [parsed.phone, resolved.customer_id, shadowDefault, session, parsed.pushName || null]
    );
    const conv = convQ.rows[0];

    // Pipeline: bootstrap event for new conv
    if (conv.is_new_conv) {
      try {
        await client.query(
          `INSERT INTO crm_pipeline_events (conversation_id, from_stage, to_stage, source)
           VALUES ($1, NULL, 'baru', 'auto:conv_created')`,
          [conv.id]
        );
      } catch (err) {
        logger.warn({ err: err.message, conv_id: conv.id }, '[pipeline] bootstrap event failed');
      }
    }

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

    // Set first_inbound_at on the first inbound message for this conv (idempotent).
    await client.query(
      `UPDATE crm_conversations SET first_inbound_at = COALESCE(first_inbound_at, $2)
       WHERE id = $1`,
      [conv.id, msg.created_at]
    );

    // Mark message as read on WhatsApp (✓✓ blue) — fire ASAP, terlepas AI on/off
    // atau handover state. Cegah customer pikir pesan tidak ke-deliver.
    // Best-effort: log + swallow on failure (jangan block ingest).
    try {
      const waClient = require('../services/waClient');
      waClient.sendSeen({
        phone: conv.phone,
        messageId: parsed.wahaMessageId,
        session: conv.wa_session,
      }).catch(() => {});
    } catch {}

    // #9 Spam filter — block first-time abusers BEFORE queueing AI work
    let spamSkipped = false;
    try {
      const spam = require('../services/spamFilter');
      const r = await spam.check(client, { phone: conv.phone, body: parsed.body, conversationId: conv.id });
      if (r.spam) {
        spamSkipped = true;
        await client.query(
          `UPDATE crm_conversations SET ai_enabled = FALSE WHERE id = $1`, [conv.id]
        );
        // Insert advisory handover so it surfaces in dashboard
        await client.query(
          `INSERT INTO crm_handovers (conversation_id, message_id, reason, detail)
           VALUES ($1, $2, 'other', $3)`,
          [conv.id, msg.id, `spam_block: ${r.reason}${r.pattern ? ' ('+r.pattern+')' : ''}`]
        );
        // Pipeline: spam_blocked → lost
        try {
          const engine = require('../services/pipelineEngine');
          await engine.apply(client, conv.id, { type: 'spam_blocked' }, {
            source: 'auto:spam_filter',
            lostReason: 'other_with_note',
            lostNote: `spam_block: ${r.reason}${r.pattern ? ' ('+r.pattern+')' : ''}`,
            metadata: { reason: r.reason, pattern: r.pattern },
          });
        } catch (err) {
          logger.warn({ err: err.message }, '[pipeline] spam hook failed');
        }
      }
    } catch {}
    if (spamSkipped) {
      await client.query('COMMIT');
      const io = req.app.get('io');
      if (io) io.emit('crm:message', { conversation_id: conv.id, message: { id: msg.id, conversation_id: conv.id, body: parsed.body, direction: 'in', sender_type: 'customer' } });
      return res.json({ success: true, conversation_id: conv.id, message_id: msg.id, spam_blocked: true });
    }

    // Lead temperature — refresh on every inbound (per spec §6.3).
    // Fire-and-forget: must not block ingest.
    try {
      const leadTemp = require('../services/leadTemperature');
      leadTemp.compute(conv.id, { inboundBody: parsed.body, intent: null })
        .catch((err) => console.warn('[leadTemp] compute failed:', err.message));
    } catch {}

    // Lead distribution — only on first inbound for a conv (no assigned staff yet).
    // Fire-and-forget: assignment is best-effort, must not block ingest.
    try {
      const leadDist = require('../services/leadDistributor');
      leadDist.distribute(conv.id)
        .catch((err) => console.warn('[leadDist] distribute failed:', err.message));
    } catch {}

    // Debounce: process_after = now()+10s. If sibling pending jobs exist for
    // this conv, push them forward to the same time so the worker picks only
    // the latest one and treats the burst as a single user turn.
    const debounceSec = parseInt(process.env.INBOUND_DEBOUNCE_SEC) || 10;
    await client.query(
      `INSERT INTO crm_inbound_queue (message_id, conversation_id, process_after)
       VALUES ($1, $2, now() + ($3 || ' seconds')::interval)`,
      [msg.id, conv.id, String(debounceSec)]
    );
    await client.query(
      `UPDATE crm_inbound_queue
         SET process_after = now() + ($2 || ' seconds')::interval
       WHERE conversation_id = $1 AND status = 'pending'`,
      [conv.id, String(debounceSec)]
    );

    // CSAT auto-capture: if last outbound was a CSAT prompt and inbound is a
    // single 1-5 digit, record score and short-circuit (skip queueing AI reply).
    let csatRecorded = false;
    if (parsed.body && /^[1-5]$/.test(parsed.body.trim())) {
      const lastOut = await client.query(
        `SELECT body, created_at FROM crm_messages
         WHERE conversation_id = $1 AND direction = 'out'
         ORDER BY id DESC LIMIT 1`, [conv.id]
      );
      const lo = lastOut.rows[0];
      if (lo && /rating pengalaman chat|CSAT/i.test(lo.body || '') &&
          (Date.now() - new Date(lo.created_at).getTime()) < 24 * 3600_000) {
        await client.query(
          `INSERT INTO crm_csat (conversation_id, score) VALUES ($1, $2)`,
          [conv.id, parseInt(parsed.body.trim())]
        );
        // Don't queue AI reply for CSAT digits — operator can thank manually.
        await client.query(`DELETE FROM crm_inbound_queue WHERE message_id = $1`, [msg.id]);
        csatRecorded = true;
      }
    }

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
