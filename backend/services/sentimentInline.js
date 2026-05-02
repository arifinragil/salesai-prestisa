// Lightweight regex-based sentiment classifier. Cheap (no LLM call) — runs
// on every inbound message. Used to flag urgent handovers (angry customer).

const ANGRY = [
  /\b(marah|kesal|kecewa|menipu|tipu|bohong|jelek|parah|bobrok|ga becus|tdk profesional|tidak profesional)\b/i,
  /[!?]{3,}/,                           // many exclamations/questions
  /^[A-Z][A-Z\s!?]{15,}$/,              // ALL CAPS rant
  /\b(refund|kembalikan|cancel)\s+(uang|saya|sekarang)\b/i,
  /\b(sumpah|anjing|anjir|asu|bangsat|brengsek|kontol|memek|tolol|goblok|bodoh|bego)\b/i,
];

const FRUSTRATED = [
  /\b(udh|udah|sudah)\s+(berkali-kali|berulang|lama)\b/i,
  /\b(belum\s+ada\s+kabar|belum\s+sampai|telat|lambat\s+banget)\b/i,
  /\b(gimana\s+sih|kenapa\s+lambat|ko[k]?\s+(belum|lama|nggak))\b/i,
];

const POSITIVE = [
  /\b(makasih|terima\s+kasih|thx|thanks|mantap|keren|bagus|oke\s+banget|love|suka|cepat|cepet|puas)\b/i,
];

function classify(text) {
  if (!text) return null;
  const t = String(text);
  if (ANGRY.some((re) => re.test(t))) return 'angry';
  if (FRUSTRATED.some((re) => re.test(t))) return 'frustrated';
  if (POSITIVE.some((re) => re.test(t))) return 'positive';
  return 'neutral';
}

module.exports = { classify };
