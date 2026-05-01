const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'crm_pilot_token';

function signToken(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: opts.expiresIn || '7d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readToken(req) {
  return req.cookies?.[COOKIE_NAME] || null;
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireStaff(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const decoded = verifyToken(token);
    if (!decoded.staff_id) return res.status(401).json({ success: false, message: 'Token tidak valid' });
    req.staff = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token tidak valid' });
  }
}

module.exports = { COOKIE_NAME, signToken, setAuthCookie, clearAuthCookie, readToken, verifyToken, requireStaff };
