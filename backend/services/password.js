const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const derived = scryptSync(password, salt, 64);
  const stored64 = Buffer.from(hashHex, 'hex');
  if (derived.length !== stored64.length) return false;
  return timingSafeEqual(derived, stored64);
}

module.exports = { hashPassword, verifyPassword };
