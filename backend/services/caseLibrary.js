// backend/services/caseLibrary.js
// Relevance-ranked case-library lookup. Returns up to 3 templates,
// padded with fallback if fewer matches found.
const pg = require('../db/postgres');

const FALLBACK_SHORTCUTS = ['greeting_default', 'ask_clarify', 'escalate_default'];

async function lookup({ inboundBody, intent }) {
  const body = String(inboundBody || '').slice(0, 2000);
  const intentLabel = intent || null;
  const r = await pg.query(
    `SELECT id, shortcut, body, case_label, intent_match,
       (
         CASE WHEN intent_match = $1 THEN 50 ELSE 0 END +
         CASE WHEN $1 IS NOT NULL AND case_pattern IS NOT NULL AND $2 ~* case_pattern THEN 30
              WHEN case_pattern IS NOT NULL AND $2 ~* case_pattern THEN 30
              ELSE 0 END +
         GREATEST(0, 20 - EXTRACT(EPOCH FROM (now() - updated_at))::int / 86400 / 30)
       ) AS relevance
     FROM crm_reply_templates
     WHERE enabled = TRUE AND case_label IS NOT NULL
     ORDER BY relevance DESC, id ASC
     LIMIT 6`,
    [intentLabel, body]
  );
  const ranked = r.rows.filter((row) => Number(row.relevance) >= 30).slice(0, 3);
  if (ranked.length >= 3) return { items: ranked, lowConfidence: false };

  // Pad with fallbacks (skip duplicates by shortcut)
  const used = new Set(ranked.map((x) => x.shortcut));
  const fb = await pg.query(
    `SELECT id, shortcut, body, case_label, intent_match
     FROM crm_reply_templates
     WHERE shortcut = ANY($1) AND enabled = TRUE`,
    [FALLBACK_SHORTCUTS]
  );
  for (const f of fb.rows) {
    if (ranked.length >= 3) break;
    if (!used.has(f.shortcut)) {
      ranked.push({ ...f, relevance: 0 });
      used.add(f.shortcut);
    }
  }
  return { items: ranked.slice(0, 3), lowConfidence: true };
}

module.exports = { lookup };
