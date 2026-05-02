// backend/scripts/kbRefresh.js
// Daily KB refresh:
//   1. Embed any new pending drafts that don't yet have an embedding.
//   2. Cluster: merge new drafts into existing cluster if cosine ≥ THRESHOLD
//      with that cluster's representative; else assign new cluster_id.
//      Merge = increment frequency on representative, mark new draft 'merged'.
//   3. Auto-draft suggested_answer for top clusters (frequency ≥ 2) that
//      don't have one yet — uses active provider via aiClient.complete.
//   4. Refresh stale embeddings on crm_kb_topics (when admin edited body).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const { embed, cosine } = require('../services/embedClient');
const aiClient = require('../services/aiClient');
const rag = require('../services/aiKbRag');
const logger = require('../services/logger');

const SIMILARITY_THRESHOLD = 0.85;
const AUTO_ANSWER_MIN_FREQ = 2;

function shortQuestion(q) {
  return String(q || '').trim().slice(0, 500);
}

async function embedNewDrafts() {
  const r = await pg.query(
    `SELECT id, question FROM crm_kb_drafts
     WHERE status = 'pending' AND embedding IS NULL
     ORDER BY id ASC LIMIT 50`
  );
  if (r.rows.length === 0) return 0;
  const vectors = await embed(r.rows.map((d) => shortQuestion(d.question)));
  for (let i = 0; i < r.rows.length; i++) {
    await pg.query(`UPDATE crm_kb_drafts SET embedding = $2::jsonb WHERE id = $1`,
      [r.rows[i].id, JSON.stringify(vectors[i])]);
  }
  return r.rows.length;
}

async function clusterDrafts() {
  // Pull all pending drafts that have embedding (representatives + new)
  const r = await pg.query(
    `SELECT id, question, embedding, cluster_id, frequency
     FROM crm_kb_drafts
     WHERE status = 'pending' AND embedding IS NOT NULL
     ORDER BY id ASC`
  );
  const all = r.rows;
  if (all.length < 2) return { merged: 0, new_clusters: 0 };

  // Reps = drafts with cluster_id set (oldest in each cluster)
  const reps = all.filter((d) => d.cluster_id != null);
  const candidates = all.filter((d) => d.cluster_id == null);

  let merged = 0, newClusters = 0, nextClusterId = (reps.reduce((m, r) => Math.max(m, r.cluster_id || 0), 0)) + 1;

  for (const c of candidates) {
    const cVec = c.embedding;
    if (!Array.isArray(cVec)) continue;
    let bestRep = null, bestSim = 0;
    for (const r of reps) {
      const sim = cosine(cVec, r.embedding);
      if (sim > bestSim) { bestSim = sim; bestRep = r; }
    }
    if (bestRep && bestSim >= SIMILARITY_THRESHOLD) {
      // Merge: bump rep frequency, mark candidate as merged (status='merged')
      await pg.query(
        `UPDATE crm_kb_drafts SET frequency = frequency + 1 WHERE id = $1`,
        [bestRep.id]
      );
      await pg.query(
        `UPDATE crm_kb_drafts SET status = 'merged', cluster_id = $2,
                reviewed_at = now(), approved_topic_id = $3
         WHERE id = $1`,
        [c.id, bestRep.cluster_id, null]
      );
      merged++;
      bestRep.frequency = (bestRep.frequency || 1) + 1;
    } else {
      // New cluster — promote candidate to representative
      await pg.query(`UPDATE crm_kb_drafts SET cluster_id = $2 WHERE id = $1`,
        [c.id, nextClusterId]);
      reps.push({ ...c, cluster_id: nextClusterId, frequency: 1 });
      nextClusterId++;
      newClusters++;
    }
  }
  return { merged, new_clusters: newClusters };
}

async function autoDraftAnswers() {
  const r = await pg.query(
    `SELECT id, question, frequency FROM crm_kb_drafts
     WHERE status = 'pending'
       AND frequency >= $1
       AND (suggested_answer IS NULL OR suggested_answer = '')
     ORDER BY frequency DESC LIMIT 5`,
    [AUTO_ANSWER_MIN_FREQ]
  );
  let drafted = 0, errors = 0;
  for (const d of r.rows) {
    try {
      const sys = `Anda staf customer service Prestisa (toko bunga online). ` +
        `Tugas: tulis 1 jawaban singkat (≤120 kata) untuk pertanyaan customer berulang berikut. ` +
        `Bahasa Indonesia santai-sopan. Pakai sapaan "Kak". JANGAN sebut harga spesifik atau angka diskon — pakai range/template.`;
      const resp = await aiClient.complete({
        system: sys,
        messages: [{ role: 'user', content: `Pertanyaan: "${d.question}"\n\nTulis jawaban draft:` }],
        max_tokens: 250,
        temperature: 0.4,
      });
      const text = (resp.text || '').trim();
      if (!text) { errors++; continue; }
      await pg.query(
        `UPDATE crm_kb_drafts SET suggested_answer = $2, auto_drafted_at = now() WHERE id = $1`,
        [d.id, text]
      );
      drafted++;
    } catch (err) {
      errors++;
      logger.warn({ err: err.message, draft_id: d.id }, '[kbRefresh] auto-draft failed');
    }
  }
  return { drafted, errors };
}

async function run() {
  const embedded = await embedNewDrafts();
  const { merged, new_clusters } = await clusterDrafts();
  const { drafted, errors: draftErrors } = await autoDraftAnswers();
  const refreshed = await rag.refreshStale();
  logger.info({ embedded, merged, new_clusters, drafted, draftErrors, kb_topics_refreshed: refreshed },
    '[kbRefresh] done');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[kbRefresh] failed'); process.exit(1); });
}
module.exports = { run };
