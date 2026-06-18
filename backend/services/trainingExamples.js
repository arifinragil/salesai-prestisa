// backend/services/trainingExamples.js
const pg = require('../db/postgres');

// Pure: choose <=perCategory per category, <=limit total, prefer high usage + recent.
function pickExamples(rows, { limit = 5, perCategory = 2 } = {}) {
  const sorted = [...rows].sort((a, b) =>
    (b.usage_count - a.usage_count) ||
    (new Date(b.last_used_at || 0) - new Date(a.last_used_at || 0)));
  const perCat = {}; const out = [];
  for (const r of sorted) {
    perCat[r.category] = (perCat[r.category] || 0);
    if (perCat[r.category] >= perCategory) continue;
    perCat[r.category]++; out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function formatExamplesBlock(examples) {
  if (!examples.length) return '';
  const lines = examples.map((e, i) =>
    `Contoh ${i + 1}:\nCase: ${e.case_pattern}\nKategori: ${e.category}${e.subtype ? ` (${e.subtype})` : ''}\nAnalisa: ${e.analysis}` +
    (e.suggested_action ? `\nAction: ${e.suggested_action}` : '') +
    (e.suggested_script ? `\nScript: ${e.suggested_script}` : ''));
  return `\nCONTOH KASUS YANG SUDAH DI-REVIEW SUPERVISOR (gunakan sebagai referensi):\n\n${lines.join('\n\n')}\n`;
}

async function getActiveExamples({ limit = 5, perCategory = 2 } = {}) {
  const { rows } = await pg.query(
    `SELECT id, category, subtype, case_pattern, analysis, suggested_action, suggested_script, usage_count, last_used_at
     FROM crm_ai_training_examples WHERE active = TRUE`);
  const picked = pickExamples(rows, { limit, perCategory });
  if (picked.length) {
    await pg.query(
      `UPDATE crm_ai_training_examples SET usage_count = usage_count + 1, last_used_at = now() WHERE id = ANY($1::bigint[])`,
      [picked.map((p) => p.id)]);
  }
  return picked;
}

// category mapping: our buckets A/B/C/D <-> brief categories
const CAT_OF_BUCKET = { A: 'customer', B: 'sales_handling', C: 'offer', D: 'process' };

async function createFromRevision({ action_id, category, subtype, analysis, suggested_action, suggested_script, created_by }) {
  if (!category || !analysis) return null;
  const { rows } = await pg.query(
    `INSERT INTO crm_ai_training_examples (case_pattern, category, subtype, analysis, suggested_action, suggested_script, source, source_action_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'supervisor_revise',$7,$8) RETURNING id`,
    [analysis.slice(0, 200), category, subtype || null, analysis, suggested_action || null, suggested_script || null, action_id || null, created_by || null]);
  return rows[0].id;
}

module.exports = { pickExamples, formatExamplesBlock, getActiveExamples, createFromRevision, CAT_OF_BUCKET };
