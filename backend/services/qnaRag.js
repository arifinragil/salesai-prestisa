// backend/services/qnaRag.js
// Vector Q&A retrieval — reuse embedClient (gemini-embedding-001) + cosine.
// Embeddings disimpan JSONB di crm_qna (pola aiKbRag). Tanpa pgvector.
const pg = require('../db/postgres');
const { embed, cosine } = require('./embedClient');

async function retrieveSimilar(queryText, opts = {}) {
  const { k = 3, minScore = 0.72, business_number = null } = opts;
  const q = String(queryText || '').trim();
  if (!q) return [];
  const [qVec] = await embed([q]);
  if (!qVec || !qVec.length) return [];
  const params = [];
  let where = `enabled = true AND embedding IS NOT NULL`;
  if (business_number) { params.push(business_number); where += ` AND (business_number IS NULL OR business_number = $${params.length})`; }
  const { rows } = await pg.query(`SELECT id, question, answer, embedding FROM crm_qna WHERE ${where}`, params);
  const ranked = rows
    .map((r) => ({ id: r.id, question: r.question, answer: r.answer, score: Array.isArray(r.embedding) ? cosine(qVec, r.embedding) : 0 }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (ranked.length) {
    await pg.query(`UPDATE crm_qna SET times_served = times_served + 1 WHERE id = ANY($1::bigint[])`, [ranked.map((r) => r.id)]).catch(() => {});
  }
  return ranked;
}

async function upsertQna({ question, answer, intent = null, source = 'curated', business_number = null, created_by = null }) {
  if (!question || !answer) return null;
  const { rows: ex } = await pg.query(`SELECT id FROM crm_qna WHERE lower(trim(question)) = lower(trim($1)) LIMIT 1`, [question]);
  if (ex[0]) {
    await pg.query(`UPDATE crm_qna SET answer = $2, win_count = win_count + 1, updated_at = now(), embedding = NULL, embedding_hash = NULL WHERE id = $1`, [ex[0].id, answer]);
    return ex[0].id;
  }
  const { rows } = await pg.query(
    `INSERT INTO crm_qna (question, answer, intent, source, business_number, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [question, answer, intent, source, business_number, created_by]
  );
  return rows[0].id;
}

async function embedPending(limit = 200) {
  const { rows } = await pg.query(
    `SELECT id, question FROM crm_qna
      WHERE enabled = true AND (embedding IS NULL OR embedding_hash IS NULL OR embedding_hash != md5(question))
      LIMIT $1`, [limit]
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.question));
  for (let i = 0; i < rows.length; i++) {
    await pg.query(`UPDATE crm_qna SET embedding = $2::jsonb, embedding_hash = md5(question), updated_at = now() WHERE id = $1`,
      [rows[i].id, JSON.stringify(vecs[i])]);
  }
  return rows.length;
}

module.exports = { retrieveSimilar, upsertQna, embedPending };
