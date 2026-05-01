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

module.exports = { upload, UPLOAD_ROOT, MAX_BYTES, publicUrlFor, attachmentTypeFor };
