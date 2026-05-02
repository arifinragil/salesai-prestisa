// Lightweight embedding client — Gemini gemini-embedding-001 (3072 dim).
// Free tier quota generous. Reuses GEMINI_API_KEY already configured.
// Uses per-text embedContent (the model doesn't support batchEmbedContents
// on v1beta — only async batch which is overkill for small KBs).
const MODEL = process.env.EMBED_MODEL || 'gemini-embedding-001';

async function embedOne(text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: { parts: [{ text: String(text) }] } }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`embed ${r.status}: ${err.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.embedding?.values || [];
}

async function embed(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  // Sequential to avoid rate-limit; KBs are small (~10s of topics).
  const out = [];
  for (const t of texts) out.push(await embedOne(t, apiKey));
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { embed, cosine, MODEL };
