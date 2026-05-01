const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, '..', '..', 'uploads');
const PUBLIC_BASE = process.env.PUBLIC_UPLOAD_BASE || 'https://salesai.prestisa.net/uploads';
const MAX_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES) || 25 * 1024 * 1024; // 25 MB

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) { cb(null, UPLOAD_ROOT); },
  filename(_req, file, cb) {
    const id = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname || '').slice(0, 8) || '';
    cb(null, `${Date.now()}-${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
});

function publicUrlFor(filename) {
  return `${PUBLIC_BASE.replace(/\/+$/, '')}/${filename}`;
}

function attachmentTypeFor(mimetype) {
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

function extFor(mimetype) {
  const map = {
    'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
    'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
  };
  return map[String(mimetype || '').toLowerCase()] || '';
}

// Download a file from a remote URL (WAHA) and save it under uploads/ with a
// random filename. Returns { localPath, publicUrl, mimetype, size }.
async function downloadAndSave(rawUrl, opts = {}) {
  if (!rawUrl) throw new Error('rawUrl required');

  // Rewrite WAHA-internal localhost URL to its public host so we can reach it.
  let url = rawUrl;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) && process.env.WAHA_API_URL) {
    url = url.replace(/^https?:\/\/[^/]+/, process.env.WAHA_API_URL.replace(/\/+$/, ''));
  }

  const headers = {};
  if (/waha/i.test(url) && process.env.WAHA_API_KEY) headers['X-Api-Key'] = process.env.WAHA_API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`download ${res.status}: ${txt.slice(0, 120)}`);
  }
  const mimetype = opts.mimetype || res.headers.get('content-type') || 'application/octet-stream';
  const ext = opts.ext || extFor(mimetype) || '';
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${Date.now()}-${id}${ext}`;
  const localPath = path.join(UPLOAD_ROOT, filename);

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buf);

  return {
    localPath,
    filename,
    publicUrl: publicUrlFor(filename),
    mimetype,
    size: buf.length,
  };
}

module.exports = { upload, UPLOAD_ROOT, MAX_BYTES, publicUrlFor, attachmentTypeFor, extFor, downloadAndSave };
