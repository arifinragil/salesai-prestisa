// Detect when AI keeps answering the SAME question without satisfying the
// customer — signal that AI is stuck and should hand over.

const pg = require('../db/postgres');

// Normalize text to detect "same question rephrased": lowercase, strip
// punctuation, collapse whitespace.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Compute Jaccard similarity on word sets
function jaccard(a, b) {
  const setA = new Set(norm(a).split(' ').filter(Boolean));
  const setB = new Set(norm(b).split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / new Set([...setA, ...setB]).size;
}

// Returns true if the latest inbound is similar to ≥2 of the last 5 inbounds
// AND AI has already replied to those — i.e. AI is failing to address it.
async function isRepeatedQuestion(client, conversationId, currentText) {
  const { rows } = await client.query(
    `SELECT direction, sender_type, body
     FROM crm_messages
     WHERE conversation_id = $1
     ORDER BY id DESC LIMIT 12`,
    [conversationId]
  );
  // rows is most-recent-first. Look for prior inbound texts.
  const priorInbounds = rows.filter((r) => r.direction === 'in').slice(1, 6); // skip current
  let similarCount = 0;
  for (const p of priorInbounds) {
    if (jaccard(currentText, p.body) >= 0.55) similarCount++;
  }
  return similarCount >= 2;
}

module.exports = { isRepeatedQuestion, jaccard, norm };
