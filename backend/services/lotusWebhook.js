/**
 * Lotus webhook caller — POST outbound message ke
 *   https://lotus.prestisa.id/lavenger-backend/public/api/save-hsm-message
 *
 * Dipanggil setelah berhasil kirim HSM / freetext / media dari salesai-crm
 * supaya record-nya juga muncul di app Lotus utama.
 *
 * Non-blocking: error di-log tapi tidak melempar — kalau Lotus down,
 * kirim WA tetap sukses, hanya record di Lotus app yang miss.
 */
const logger = require('pino')({ name: 'lotus-webhook' });

const LOTUS_URL   = process.env.LOTUS_SAVE_MESSAGE_URL || 'https://lotus.prestisa.id/lavenger-backend/public/api/save-hsm-message';
const LOTUS_TOKEN = process.env.LOTUS_SAVE_MESSAGE_TOKEN || '';
const SOURCE      = 'PRESTISA_CRM';
const TIMEOUT_MS  = 8000;

/**
 * Hit webhook save-hsm-message.
 *
 * @param {object} payload
 * @param {string} payload.from          — sender brand MSISDN
 * @param {string} payload.to            — customer phone
 * @param {string} payload.messageId     — Vonage/RML message uuid (request_id)
 * @param {string} payload.messageText   — body teks rendered (HSM dgn param sudah filled, atau freetext apa adanya)
 * @param {string} payload.contactName   — nama customer
 * @param {string} [payload.hsmName]     — nama HSM (kosong untuk freetext)
 * @param {string} [payload.fileName]    — kalau ada header/attachment file
 * @param {string} [payload.fileUrl]     — URL file (public)
 * @returns {Promise<{ok: boolean, status?: number, body?: any, error?: string}>}
 */
async function saveMessage(payload) {
  if (!LOTUS_TOKEN) {
    logger.warn('LOTUS_SAVE_MESSAGE_TOKEN tidak di-set — webhook lotus dilewati');
    return { ok: false, error: 'no_token' };
  }
  const fields = {
    from:         String(payload.from || '').replace(/\D/g, ''),
    to:           String(payload.to || '').replace(/\D/g, ''),
    messageId:    payload.messageId || '',
    messageText:  payload.messageText || '',
    contactName:  payload.contactName || 'Customer',
    hsmName:      payload.hsmName || '',
    token:        LOTUS_TOKEN,
    fileName:     payload.fileName || '',
    fileUrl:      payload.fileUrl  || '',
    source:       SOURCE,
    isHsm:        !!payload.isHsm,
  };

  // Lotus expects: multipart/form-data with single text field `jsonData`
  // (JSON string of payload) + optional `file` binary. Per Postman screenshot.
  const form = new FormData();
  form.append('jsonData', JSON.stringify(fields));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(LOTUS_URL, {
      method: 'POST',
      headers: { 'Accept': 'application/json' }, // let fetch set multipart boundary
      body: form,
      signal: controller.signal,
    });
    const txt = await res.text();
    let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 400) }; }
    if (!res.ok) {
      logger.warn({ status: res.status, body: parsed, payload: { ...fields, token: '***' } },
        '[lotus-webhook] save-hsm-message non-2xx');
      return { ok: false, status: res.status, body: parsed };
    }
    logger.info({ status: res.status, to: fields.to, messageId: fields.messageId, hsm: fields.hsmName },
      '[lotus-webhook] save-hsm-message OK');
    return { ok: true, status: res.status, body: parsed };
  } catch (err) {
    logger.warn({ err: err.message, payload: { ...fields, token: '***' } },
      '[lotus-webhook] save-hsm-message error');
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { saveMessage };
