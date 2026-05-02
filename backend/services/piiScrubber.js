// Detect & redact PII in inbound/outbound messages before logging or
// forwarding to webhooks (Slack/Discord). Goal: don't leak NIK/credit card
// to 3rd parties. Detection is regex-based — high precision, low recall.

const PATTERNS = [
  { name: 'card',  re: /\b(?:\d[ -]?){13,19}\b/g, replace: '[CARD]' },           // 13-19 digit card
  { name: 'nik',   re: /\b\d{16}\b/g,             replace: '[NIK]' },             // KTP NIK
  { name: 'cvv',   re: /\b(cvv|cvc)[:\s]*\d{3,4}\b/gi, replace: '$1: [CVV]' },
  { name: 'expiry', re: /\b(0[1-9]|1[0-2])\/(20)?\d{2}\b/g, replace: '[EXP]' },
  { name: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, replace: '[EMAIL]' },
];

function redact(text) {
  if (!text) return { text, flags: {} };
  let out = String(text);
  const flags = {};
  for (const p of PATTERNS) {
    const matches = out.match(p.re);
    if (matches && matches.length) {
      flags[p.name] = matches.length;
      out = out.replace(p.re, p.replace);
    }
  }
  return { text: out, flags };
}

// Lightweight detect (no replace) — for indexing/flagging without mutating body.
function detect(text) {
  if (!text) return {};
  const flags = {};
  for (const p of PATTERNS) {
    const matches = String(text).match(p.re);
    if (matches && matches.length) flags[p.name] = matches.length;
  }
  return flags;
}

module.exports = { redact, detect };
