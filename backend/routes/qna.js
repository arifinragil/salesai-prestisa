// backend/routes/qna.js
// Admin CRUD for Vector Q&A entries (/api/qna)
const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const { upsertQna, embedPending } = require('../services/qnaRag');
const router = express.Router();

router.use(requireStaff);
router.use((req, res, next) => {
  if (req.staff?.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  next();
});

// GET / — list with optional ?q= search
router.get('/', async (req, res) => {
  const r = await pg.query(
    `SELECT id, question, answer, intent, source, enabled, times_served, win_count, created_at
     FROM crm_qna
     WHERE ($1::text IS NULL OR question ILIKE '%'||$1||'%' OR answer ILIKE '%'||$1||'%')
     ORDER BY updated_at DESC LIMIT 500`,
    [req.query.q || null]
  );
  res.json({ items: r.rows });
});

// POST / — create
router.post('/', async (req, res) => {
  const { question, answer, intent, business_number } = req.body || {};
  if (!question || !answer) return res.status(400).json({ error: 'missing' });
  const id = await upsertQna({
    question,
    answer,
    intent: intent || null,
    source: 'curated',
    business_number: business_number || null,
    created_by: req.staff.staff_id,
  });
  embedPending().catch(() => {});
  res.json({ ok: true, id });
});

// PUT /:id — update fields
router.put('/:id', async (req, res) => {
  const { question, answer, intent, enabled } = req.body || {};
  await pg.query(
    `UPDATE crm_qna
     SET question = COALESCE($2, question),
         answer = COALESCE($3, answer),
         intent = $4,
         enabled = COALESCE($5, enabled),
         embedding = NULL,
         embedding_hash = NULL,
         updated_at = now()
     WHERE id = $1`,
    [req.params.id, question || null, answer || null, intent !== undefined ? intent : null, enabled !== undefined ? enabled : null]
  );
  embedPending().catch(() => {});
  res.json({ ok: true });
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  await pg.query('DELETE FROM crm_qna WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// POST /embed-pending — trigger embedding run
router.post('/embed-pending', async (req, res) => {
  const n = await embedPending();
  res.json({ ok: true, embedded: n });
});

module.exports = router;
