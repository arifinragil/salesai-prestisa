// Only trigger handover on STRONG hedging. "mungkin" / "sepertinya" alone
// are too common in normal Indonesian speech and cause false positives.
// Require pairing with uncertainty markers (e.g., "saya kurang yakin").
const HESITATION_PATTERNS = [
  /kurang yakin/i,
  /\b(saya|aku) (tidak|gak|nggak)\s+(yakin|tahu|tau|pasti)/i,
  /tidak\s+(bisa|tau|tahu)\s+pastikan/i,
  /\bbelum (yakin|pasti|tahu)\b/i,
  /maaf,? (saya|aku) tidak (tahu|tau|yakin|bisa)/i,
  /\bsaya (kurang|nggak|gak) (paham|ngerti|tau)\b/i,
];

const SPECIFIC_ETA_PATTERNS = [
  /\bjam\s+\d{1,2}(:\d{2})?\s*(pagi|siang|sore|malam|wib)?/i,
  /\bbesok (pagi|siang|sore|malam)/i,
  /\bhari ini juga\b/i,
  /\bdalam\s+\d+\s*(menit|jam)\b/i,
];

const ETA_TEMPLATE_OK = /3\s*[-–]\s*6\s*jam/i;

function hasHesitation(reply) {
  if (!reply) return false;
  return HESITATION_PATTERNS.some((re) => re.test(reply));
}

function hasSpecificEta(reply) {
  if (!reply) return false;
  if (ETA_TEMPLATE_OK.test(reply)) return false;
  return SPECIFIC_ETA_PATTERNS.some((re) => re.test(reply));
}

function extractPriceMentions(reply) {
  if (!reply) return [];
  const out = new Set();

  const reK = /\b(\d{1,4})\s*(k|rb|ribu)\b/gi;
  let m;
  while ((m = reK.exec(reply)) !== null) {
    out.add(String(parseInt(m[1]) * 1000));
  }

  const reN = /\b(\d{1,3}(?:[.,]\d{3})+|\d{5,})\b/g;
  while ((m = reN.exec(reply)) !== null) {
    const n = parseInt(m[1].replace(/[.,]/g, ''));
    if (n >= 10000) out.add(String(n));
  }

  return Array.from(out);
}

function collectToolPrices(toolCalls) {
  const prices = new Set();
  for (const c of toolCalls || []) {
    const r = c.result;
    if (!r) continue;
    if (Array.isArray(r.products)) {
      for (const p of r.products) {
        if (p.price) prices.add(String(parseInt(p.price)));
      }
    }
    if (Array.isArray(r.promos)) {
      for (const p of r.promos) {
        if (p.discount_amount) prices.add(String(parseInt(p.discount_amount)));
      }
    }
    if (typeof r.fee === 'number') prices.add(String(r.fee));
    if (typeof r.total === 'number') prices.add(String(r.total));
    if (Array.isArray(r.orders)) {
      for (const o of r.orders) if (o.total) prices.add(String(parseInt(o.total)));
    }
    if (Array.isArray(r.items)) {
      for (const it of r.items) if (it.price) prices.add(String(parseInt(it.price)));
    }
  }
  return prices;
}

function checkReply({ reply, toolCalls }) {
  if (!reply) return { passed: false, reason: 'empty_reply' };

  if (hasHesitation(reply)) {
    return { passed: false, reason: 'hesitation' };
  }

  if (hasSpecificEta(reply)) {
    return { passed: false, reason: 'specific_eta' };
  }

  const mentioned = extractPriceMentions(reply);
  if (mentioned.length > 0) {
    const allowed = collectToolPrices(toolCalls);
    const orphan = mentioned.find((p) => !allowed.has(p));
    if (orphan) {
      return { passed: false, reason: 'price_not_in_tool_results', detail: { orphan, allowed: Array.from(allowed) } };
    }
  }

  return { passed: true };
}

module.exports = {
  checkReply,
  extractPriceMentions,
  hasHesitation,
  hasSpecificEta,
  collectToolPrices,
};
