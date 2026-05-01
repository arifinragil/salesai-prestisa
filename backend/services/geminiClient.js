const { GoogleGenerativeAI } = require('@google/generative-ai');

const VALID_INTENTS = [
  'complaint', 'refund', 'cancel', 'angry',
  'legal', 'explicit_request_human', 'order_intent',
  'order_status', 'pricing', 'shipping', 'payment', 'faq', 'other',
];

const DANGEROUS_INTENTS = new Set([
  'complaint', 'refund', 'cancel', 'angry', 'legal', 'explicit_request_human',
]);

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY belum diset');
  client = new GoogleGenerativeAI(key);
  return client;
}

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const SYSTEM_PROMPT = `Kamu adalah classifier untuk pesan WhatsApp customer toko bunga online.
Klasifikasikan intent pesan ke salah satu dari:
${VALID_INTENTS.join(', ')}

Definisi:
- complaint: customer mengeluh, kecewa, marah tentang produk/layanan
- refund: minta pengembalian dana
- cancel: minta pembatalan order
- angry: nada marah/agresif tanpa konteks spesifik
- legal: ancaman hukum, viral, lapor polisi, BPSK
- explicit_request_human: minta bicara dengan orang/admin/CS manusia ("ngomong sama orang", "panggilin admin")
- order_intent: ingin pesan/order produk
- order_status: tanya status pesanan existing
- pricing: tanya harga
- shipping: tanya ongkir/pengiriman
- payment: pertanyaan pembayaran (VA, transfer, bukti)
- faq: pertanyaan umum (jam buka, cara order, area cover)
- other: tidak masuk di atas

Output HANYA JSON valid: {"intent": "...", "confidence": 0.0-1.0}
Jangan kasih penjelasan apa-apa di luar JSON.`;

function parseJsonish(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  try { return JSON.parse(raw.trim()); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

async function classifyIntent(messageText) {
  let model;
  try {
    model = getClient().getGenerativeModel({
      model: MODEL(),
      systemInstruction: SYSTEM_PROMPT,
    });
  } catch (err) {
    return { intent: 'unknown', confidence: 0, degraded: true, error: err.message };
  }

  let raw;
  try {
    const res = await model.generateContent(String(messageText || '').slice(0, 2000));
    raw = res.response.text();
  } catch (err) {
    return { intent: 'unknown', confidence: 0, degraded: true, error: err?.message };
  }

  const parsed = parseJsonish(raw);
  if (!parsed || !parsed.intent || !VALID_INTENTS.includes(parsed.intent)) {
    return { intent: 'other', confidence: 0, parseError: 'unparseable_or_unknown', raw: String(raw).slice(0, 200) };
  }
  return {
    intent: parsed.intent,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  };
}

function isDangerous(intent) { return DANGEROUS_INTENTS.has(intent); }

module.exports = { classifyIntent, isDangerous, VALID_INTENTS, DANGEROUS_INTENTS };
