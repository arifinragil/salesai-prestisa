// Spam contact filter — block first-time inbound that smells like spam/affiliate/phishing.
// Decision happens in webhook ingest BEFORE AI work to avoid wasted LLM cost.
const settings = require('./settings');

const SPAM_PATTERNS = [
  /\bhttps?:\/\/(?!.*(prestisa|wa\.me))/i,           // URL outside our domain
  /\b(t\.me|bit\.ly|tinyurl|cutt\.ly|s\.id)\b/i,     // shortener
  /\b(forex|crypto|btc|usdt|gambling|judi|togel|slot online)\b/i,
  /\b(invest(?:asi)? ?(?:online|profit)|earn from home|kerja sampingan online)\b/i,
  /\b(pinjaman online|pinjol|kredit cepat|tanpa BI checking)\b/i,
];

function looksLikeSpam(body) {
  const text = (body || '').toString().slice(0, 600);
  if (!text) return null;
  for (const re of SPAM_PATTERNS) {
    if (re.test(text)) return re.source.slice(0, 60);
  }
  return null;
}

async function check(client, { phone, body, conversationId }) {
  const enabled = await settings.getSetting('spam_filter_enabled', true);
  if (enabled === false) return { spam: false };

  // Skip if phone already on block list
  const blocked = await client.query(`SELECT reason FROM crm_spam_blocks WHERE phone = $1 AND released_at IS NULL`, [phone]);
  if (blocked.rows[0]) return { spam: true, reason: blocked.rows[0].reason || 'blocklist', cached: true };

  // Only screen first-time contacts (≤2 inbound msgs total)
  const cnt = await client.query(
    `SELECT COUNT(*)::int AS n FROM crm_messages WHERE conversation_id = $1 AND direction='in'`,
    [conversationId]
  );
  if (cnt.rows[0].n > 2) return { spam: false };

  const matched = looksLikeSpam(body);
  if (!matched) return { spam: false };
  await client.query(
    `INSERT INTO crm_spam_blocks (phone, reason, detail) VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO NOTHING`,
    [phone, 'first_msg_spam', `pattern: ${matched}; sample: ${(body || '').slice(0, 200)}`]
  );
  return { spam: true, reason: 'first_msg_spam', pattern: matched };
}

module.exports = { check, looksLikeSpam };
