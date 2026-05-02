// Lightweight language detect — heuristic only, no external lib.
// Returns 'id' | 'en' | 'zh' | null. Conservative — only flips off id when strong signal.
const ID_MARKERS = /\b(saya|aku|kak|mau|bisa|tolong|terima kasih|makasih|halo|selamat|ke mana|kemana|berapa|harga|kirim|pesan|order|bunga|untuk|dengan|kepada|tanggal)\b/i;
const EN_MARKERS = /\b(the|please|thank|hello|hi|can you|could you|i need|i want|how much|order|flower|delivery|tomorrow|today|good morning)\b/i;
const ZH_MARKER = /[一-鿿]/;

function detect(text) {
  const t = (text || '').trim();
  if (!t || t.length < 4) return null;
  if (ZH_MARKER.test(t)) return 'zh';
  const idHits = (t.match(ID_MARKERS) || []).length;
  const enHits = (t.match(EN_MARKERS) || []).length;
  if (enHits >= 2 && idHits === 0) return 'en';
  if (idHits >= 1) return 'id';
  // ASCII-only with English-looking diphthongs and no id markers
  if (/^[\x20-\x7E]+$/.test(t) && enHits >= 1 && idHits === 0) return 'en';
  return null;
}

module.exports = { detect };
