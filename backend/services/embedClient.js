// Lightweight embedding client — OpenAI text-embedding-3-small (1536 dim).
// One call per text or batch.
const MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

async function embed(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`embed ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.data.map((d) => d.embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { embed, cosine, MODEL };
