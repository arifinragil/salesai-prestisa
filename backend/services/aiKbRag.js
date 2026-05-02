// Semantic KB lookup — tools-side. Embed the customer query, cosine-rank
// against pre-computed KB topic embeddings (cached in PG). Refresh stale.
const crypto = require('crypto');
const pg = require('../db/postgres');
const { embed, cosine } = require('./embedClient');
const logger = require('./logger');

const REFRESH_BATCH = 20;

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

async function refreshStale() {
  const { rows } = await pg.query(
    `SELECT id, topic, body FROM crm_kb_topics
     WHERE enabled = TRUE AND (
       embedding IS NULL OR embedding_hash IS NULL
       OR embedding_hash != md5(topic || COALESCE(body,''))::varchar
     ) LIMIT $1`,
    [REFRESH_BATCH]
  );
  if (!rows.length) return 0;
  const texts = rows.map((r) => `Topic: ${r.topic}\n${r.body || ''}`);
  let vectors;
  try { vectors = await embed(texts); }
  catch (err) { logger.warn({ err: err.message }, '[kb-rag] embed failed'); return 0; }
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    await pg.query(
      `UPDATE crm_kb_topics
       SET embedding = $2::jsonb, embedded_at = now(),
           embedding_hash = md5(topic || COALESCE(body,''))::varchar
       WHERE id = $1`,
      [t.id, JSON.stringify(vectors[i])]
    );
  }
  logger.info({ refreshed: rows.length }, '[kb-rag] refreshed');
  return rows.length;
}

async function search(query, k = 3) {
  await refreshStale();
  const { rows } = await pg.query(
    `SELECT id, topic, body, embedding FROM crm_kb_topics
     WHERE enabled = TRUE AND embedding IS NOT NULL`
  );
  if (!rows.length) return [];
  let qVec;
  try { qVec = (await embed([query]))[0]; }
  catch (err) { logger.warn({ err: err.message }, '[kb-rag] embed query failed'); return []; }
  const scored = rows.map((r) => {
    const vec = Array.isArray(r.embedding) ? r.embedding : null;
    return { id: r.id, topic: r.topic, body: r.body, score: vec ? cosine(qVec, vec) : 0 };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, k).filter((r) => r.score > 0.4);
}

module.exports = { search, refreshStale };
