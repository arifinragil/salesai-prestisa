const express = require('express');
const pg = require('../db/postgres');
const { verifyPassword } = require('../services/password');
const { signToken, setAuthCookie, clearAuthCookie, requireStaff } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password wajib diisi' });
  }
  const { rows } = await pg.query(
    `SELECT id, username, password_hash, full_name, role, active FROM staff_users WHERE username = $1`,
    [username]
  );
  const user = rows[0];
  if (!user || !user.active) return res.status(401).json({ success: false, message: 'Akun tidak valid' });
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ success: false, message: 'Password salah' });
  await pg.query(`UPDATE staff_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
  const token = signToken({ staff_id: user.id, username: user.username, role: user.role });
  setAuthCookie(res, token);
  res.json({ success: true, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
});

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.get('/me', requireStaff, async (req, res) => {
  const { rows } = await pg.query(
    `SELECT id, username, full_name, role FROM staff_users WHERE id = $1`,
    [req.staff.staff_id]
  );
  if (!rows[0]) return res.status(401).json({ success: false, message: 'Akun tidak ditemukan' });
  res.json({ success: true, user: rows[0] });
});

module.exports = router;
