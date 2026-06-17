// Parse root_cause_tag JSON suffix from Gemini summary output.
const { isValidKey } = require('./rootCauseTaxonomy');

const JSON_LINE_RE = /\{[^{}\n]*"root_cause_tag"\s*:\s*"[a-z_]+"[^{}\n]*\}\s*$/m;

function parseRootCauseFromSummary(rawText) {
  if (!rawText) return { summary: '', tag: null, confidence: null };
  const trimmed = String(rawText).trim();
  const m = trimmed.match(JSON_LINE_RE);
  if (!m) return { summary: trimmed, tag: null, confidence: null };
  let parsed;
  try { parsed = JSON.parse(m[0]); }
  catch { return { summary: trimmed, tag: null, confidence: null }; }
  const tag = isValidKey(parsed.root_cause_tag) ? parsed.root_cause_tag : null;
  const conf = Number(parsed.confidence);
  const confidence = (!Number.isNaN(conf) && conf >= 0 && conf <= 1) ? conf : null;
  const summary = trimmed.replace(JSON_LINE_RE, '').trim();
  return { summary, tag, confidence };
}

module.exports = { parseRootCauseFromSummary };
