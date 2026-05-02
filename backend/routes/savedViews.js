const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);

const SCOPES = ['inbox', 'pipeline'];

router.get('/', async (req, res) => {
  const scope = req.query.scope;
  if (scope && !SCOPES.includes(scope)) {
    return res.status(400).json({ success: false, message: 'scope must be inbox|pipeline' });
  }
  const where = ['(staff_id = $1 OR is_shared = TRUE)'];
  const params = [req.staff.staff_id];
  if (scope) { params.push(scope); where.push(`scope = $${params.length}`); }
  const { rows } = await pg.query(
    `SELECT id, staff_id, scope, name, filters, is_shared, created_at
     FROM crm_saved_views WHERE ${where.join(' AND ')}
     ORDER BY is_shared DESC, name`, params
  );
  res.json({ success: true, items: rows });
});

router.post('/', async (req, res) => {
  const { scope, name, filters, is_shared } = req.body || {};
  if (!SCOPES.includes(scope)) return res.status(400).json({ success: false, message: 'scope required' });
  if (!name || name.length < 2) return res.status(400).json({ success: false, message: 'name min 2 char' });
  if (is_shared && req.staff.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'only admin can create shared view' });
  }
  const r = await pg.query(
    `INSERT INTO crm_saved_views (staff_id, scope, name, filters, is_shared)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5, FALSE)) RETURNING id`,
    [req.staff.staff_id, scope, name, JSON.stringify(filters || {}), !!is_shared]
  );
  res.json({ success: true, id: r.rows[0].id });
});

router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await pg.query(`SELECT staff_id, is_shared FROM crm_saved_views WHERE id = $1`, [id]);
  const v = r.rows[0];
  if (!v) return res.status(404).json({ success: false, message: 'not found' });
  if (v.is_shared && req.staff.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'only admin can edit shared view' });
  }
  if (!v.is_shared && v.staff_id !== req.staff.staff_id) {
    return res.status(403).json({ success: false, message: 'not your view' });
  }
  const { name, filters } = req.body || {};
  const sets = [];
  const params = [id];
  if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
  if (filters !== undefined) { params.push(JSON.stringify(filters)); sets.push(`filters = $${params.length}::jsonb`); }
  if (!sets.length) return res.json({ success: true });
  await pg.query(`UPDATE crm_saved_views SET ${sets.join(', ')} WHERE id = $1`, params);
  res.json({ success: true });
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const r = await pg.query(`SELECT staff_id, is_shared FROM crm_saved_views WHERE id = $1`, [id]);
  const v = r.rows[0];
  if (!v) return res.status(404).json({ success: false, message: 'not found' });
  if (v.is_shared && req.staff.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'only admin can delete shared view' });
  }
  if (!v.is_shared && v.staff_id !== req.staff.staff_id) {
    return res.status(403).json({ success: false, message: 'not your view' });
  }
  await pg.query(`DELETE FROM crm_saved_views WHERE id = $1`, [id]);
  res.json({ success: true });
});

module.exports = router;
