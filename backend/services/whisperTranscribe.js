// Voice/audio → text via OpenAI Whisper. Returns { text, model } or throws.
// Used by aiAgent for inbound voice notes.
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL = process.env.WHISPER_MODEL || 'whisper-1';

async function downloadToTmp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1]) || 'ogg';
  const tmp = path.join(os.tmpdir(), `wa-voice-${Date.now()}.${ext}`);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

async function transcribe(url, language = 'id') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  const tmpFile = await downloadToTmp(url);
  try {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(tmpFile)]), path.basename(tmpFile));
    fd.append('model', MODEL);
    if (language) fd.append('language', language);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`whisper ${r.status}: ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    return { text: (data.text || '').trim(), model: MODEL };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

module.exports = { transcribe };
