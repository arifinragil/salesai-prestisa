const jwt = require('jsonwebtoken');
const pg = require('../db/postgres');

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'crm_pilot_token';

// Authentik group → CRM role mapping. First match wins (priority order).
const AUTHENTIK_GROUP_ROLE_MAP = [
  ['super_admin',  'admin'],
  ['it',           'admin'],
  ['finance',      'admin'],
  ['cs',           'operator'],
  ['acquisition',  'acquisition'],
  ['retention',    'retention'],
];
const DEFAULT_ROLE_FROM_AUTHENTIK = 'viewer';

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

function mapRole(groupsHeader) {
  const groups = String(groupsHeader || '').split(/[,;|]/).map((g) => g.trim().toLowerCase()).filter(Boolean);
  for (const [g, role] of AUTHENTIK_GROUP_ROLE_MAP) {
    if (groups.includes(g)) return role;
  }
  return DEFAULT_ROLE_FROM_AUTHENTIK;
}

// Auto-provision (or refresh) staff_users row from Authentik headers.
// Returns the staff row or null if headers absent/invalid.
async function provisionFromAuthentik(req) {
  const uid = req.get('X-Authentik-Uid');
  const username = req.get('X-Authentik-Username');
  const email = req.get('X-Authentik-Email');
  const fullName = req.get('X-Authentik-Name');
  const groups = req.get('X-Authentik-Groups');
  if (!uid || !username) return null;

  const role = mapRole(groups);

  // Lookup by authentik_uid first (stable), then by username (legacy)
  let r = await pg.query(`SELECT id, username, role, active FROM staff_users WHERE authentik_uid = $1 LIMIT 1`, [uid]);
  if (!r.rows[0]) {
    r = await pg.query(`SELECT id, username, role, active FROM staff_users WHERE username = $1 LIMIT 1`, [username]);
  }

  if (r.rows[0]) {
    // Existing user — update role + bind authentik_uid + last seen
    const u = r.rows[0];
    await pg.query(
      `UPDATE staff_users
         SET role = $2, authentik_uid = $3, full_name = COALESCE(NULLIF($4,''), full_name),
             active = TRUE, last_seen_at = now()
       WHERE id = $1`,
      [u.id, role, uid, fullName || '']
    );
    return { staff_id: u.id, username, role };
  }

  // New user — auto-create with placeholder password (Authentik handles auth)
  const ins = await pg.query(
    `INSERT INTO staff_users (username, full_name, role, password_hash, active, authentik_uid, last_seen_at)
     VALUES ($1, $2, $3, 'authentik:no-local-pw', TRUE, $4, now())
     ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, authentik_uid = EXCLUDED.authentik_uid,
       active = TRUE, last_seen_at = now()
     RETURNING id`,
    [username, fullName || username, role, uid]
  );
  return { staff_id: ins.rows[0].id, username, role };
}

// Auth gate. Authentik headers take priority over local JWT cookie.
// If Authentik headers absent (e.g. break-glass /api/auth/* path or webhook),
// fall back to JWT.
async function requireStaff(req, res, next) {
  // Try Authentik first
  if (req.get('X-Authentik-Uid')) {
    try {
      const staff = await provisionFromAuthentik(req);
      if (staff) { req.staff = staff; req.staff.via = 'authentik'; return next(); }
    } catch (err) {
      console.error('[auth] authentik provision failed:', err.message);
    }
  }

  // Fallback to JWT cookie
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const decoded = verifyToken(token);
    if (!decoded.staff_id) return res.status(401).json({ success: false, message: 'Token tidak valid' });
    req.staff = decoded;
    req.staff.via = 'jwt';
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token tidak valid' });
  }
}

module.exports = { COOKIE_NAME, signToken, setAuthCookie, clearAuthCookie, readToken, verifyToken, requireStaff, mapRole, AUTHENTIK_GROUP_ROLE_MAP, DEFAULT_ROLE_FROM_AUTHENTIK };
