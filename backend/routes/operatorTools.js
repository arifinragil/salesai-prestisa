const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);

// ── Tags ─────────────────────────────────────────────────────────────────────

router.get('/tags', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT t.id, t.name, t.color, t.description, t.maps_to_pipeline_type,
            (SELECT COUNT(*) FROM crm_conversation_tags WHERE tag_id = t.id) AS conv_count
     FROM crm_tags t ORDER BY t.name`
  );
  res.json({ success: true, items: rows });
});

const VALID_PIPELINE_TYPES = new Set(['papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b', 'unknown']);

router.post('/tags', async (req, res) => {
  const { name, color, description, maps_to_pipeline_type } = req.body || {};
  if (!name || !/^[a-zA-Z0-9 _-]{2,48}$/.test(name)) {
    return res.status(400).json({ success: false, message: 'name 2-48 chars (letters/digits/space/_/-)' });
  }
  const mapType = maps_to_pipeline_type && VALID_PIPELINE_TYPES.has(maps_to_pipeline_type) ? maps_to_pipeline_type : null;
  try {
    const r = await pg.query(
      `INSERT INTO crm_tags (name, color, description, maps_to_pipeline_type) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, color || 'slate', description || null, mapType]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'name already exists' });
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/tags/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, color, description, maps_to_pipeline_type } = req.body || {};
  let mapType = maps_to_pipeline_type;
  if (mapType === '') mapType = null; // explicit clear
  if (mapType && mapType !== null && !VALID_PIPELINE_TYPES.has(mapType)) {
    return res.status(400).json({ success: false, message: `maps_to_pipeline_type must be one of: ${[...VALID_PIPELINE_TYPES].join('|')}` });
  }
  await pg.query(
    `UPDATE crm_tags SET
       name = COALESCE($2, name),
       color = COALESCE($3, color),
       description = COALESCE($4, description),
       maps_to_pipeline_type = $5
     WHERE id = $1`,
    [id, name || null, color || null, description ?? null, mapType ?? null]
  );
  res.json({ success: true });
});

router.delete('/tags/:id', async (req, res) => {
  await pg.query(`DELETE FROM crm_tags WHERE id = $1`, [parseInt(req.params.id)]);
  res.json({ success: true });
});

// Conversation ↔ tag link (for inbox + filter)
router.post('/conversations/:id/tags', async (req, res) => {
  const id = parseInt(req.params.id);
  const tagIds = Array.isArray(req.body?.tag_ids) ? req.body.tag_ids.map((n) => parseInt(n)).filter(Boolean) : [];
  await pg.query('BEGIN');
  try {
    await pg.query(`DELETE FROM crm_conversation_tags WHERE conversation_id = $1`, [id]);
    for (const tagId of tagIds) {
      await pg.query(
        `INSERT INTO crm_conversation_tags (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, tagId]
      );
    }
    await pg.query('COMMIT');

    // Pipeline: tag-driven side effects
    try {
      const engine = require('../services/pipelineEngine');
      const mapped = await pg.query(
        `SELECT t.maps_to_pipeline_type FROM crm_tags t
         JOIN crm_conversation_tags ct ON ct.tag_id = t.id
         WHERE ct.conversation_id = $1 AND t.maps_to_pipeline_type IS NOT NULL
         ORDER BY t.id LIMIT 1`,
        [id]
      );
      if (mapped.rows[0]?.maps_to_pipeline_type) {
        await engine.setType(pg, id, mapped.rows[0].maps_to_pipeline_type);
      }
      const flagged = await pg.query(
        `SELECT 1 FROM crm_tags t JOIN crm_conversation_tags ct ON ct.tag_id = t.id
         WHERE ct.conversation_id = $1 AND LOWER(t.name) ~ 'vip|loyal|korporat'
         LIMIT 1`, [id]
      );
      if (flagged.rows.length) {
        await pg.query(`UPDATE crm_conversations SET manual_stage_override = TRUE WHERE id = $1`, [id]);
      }
    } catch (err) { console.warn('[pipeline] tag hook failed:', err.message); }

    res.json({ success: true, tag_ids: tagIds });
  } catch (err) {
    await pg.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/conversations/:id/tags', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT t.id, t.name, t.color, COALESCE(ct.auto_tagged, FALSE) AS auto
     FROM crm_tags t
     JOIN crm_conversation_tags ct ON ct.tag_id = t.id
     WHERE ct.conversation_id = $1 ORDER BY t.name`, [id]
  );
  res.json({ success: true, items: rows });
});

// ── Conversation notes (operator-only, internal) ─────────────────────────────

router.put('/conversations/:id/notes', async (req, res) => {
  const id = parseInt(req.params.id);
  const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 4000) : null;
  await pg.query(`UPDATE crm_conversations SET notes = $2, updated_at = now() WHERE id = $1`, [id, notes]);
  res.json({ success: true });
});

router.get('/conversations/:id/notes', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(`SELECT notes FROM crm_conversations WHERE id = $1`, [id]);
  res.json({ success: true, notes: rows[0]?.notes || '' });
});

// ── AI feedback (operator 👍/👎 on AI replies, seed for eval) ───────────────

router.post('/messages/:id/feedback', async (req, res) => {
  const id = parseInt(req.params.id);
  const { score } = req.body || {};
  if (![1, -1, 0].includes(score)) {
    return res.status(400).json({ success: false, message: 'score must be 1, -1, or 0 (clear)' });
  }
  if (score === 0) {
    await pg.query(
      `UPDATE crm_messages SET feedback = NULL, feedback_by = NULL, feedback_at = NULL WHERE id = $1`,
      [id]
    );
  } else {
    await pg.query(
      `UPDATE crm_messages SET feedback = $2, feedback_by = $3, feedback_at = now() WHERE id = $1`,
      [id, score, req.staff.staff_id]
    );
  }
  res.json({ success: true, score });
});

router.get('/feedback/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const onlyDown = req.query.only_down === 'true';
  const { rows } = await pg.query(
    `SELECT m.id, m.created_at, m.feedback, m.feedback_at, c.id AS conversation_id, c.phone,
            LEFT(m.body, 200) AS body, m.ai_metadata->>'tools_called' AS tools,
            m.ai_metadata->>'provider' AS provider, m.ai_metadata->>'model' AS model
     FROM crm_messages m
     JOIN crm_conversations c ON c.id = m.conversation_id
     WHERE m.feedback IS NOT NULL ${onlyDown ? 'AND m.feedback = -1' : ''}
     ORDER BY m.feedback_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ success: true, items: rows });
});

// ── Reply templates ──────────────────────────────────────────────────────────

router.get('/reply-templates', async (req, res) => {
  const includeDisabled = req.query.all === 'true';
  const { rows } = await pg.query(
    `SELECT id, shortcut, title, body, category, enabled, created_at, updated_at
     FROM crm_reply_templates ${includeDisabled ? '' : 'WHERE enabled = TRUE'}
     ORDER BY category NULLS LAST, shortcut`
  );
  res.json({ success: true, items: rows });
});

router.post('/reply-templates', async (req, res) => {
  const { shortcut, title, body, category } = req.body || {};
  if (!shortcut || !title || !body) return res.status(400).json({ success: false, message: 'shortcut, title, body required' });
  if (!/^[a-z0-9_-]{2,32}$/.test(shortcut)) return res.status(400).json({ success: false, message: 'shortcut must be 2-32 [a-z0-9_-]' });
  try {
    const r = await pg.query(
      `INSERT INTO crm_reply_templates (shortcut, title, body, category, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [shortcut, title.slice(0, 120), body, category || null, req.staff.staff_id]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'shortcut already exists' });
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/reply-templates/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { shortcut, title, body, category, enabled } = req.body || {};
  await pg.query(
    `UPDATE crm_reply_templates SET
       shortcut = COALESCE($2, shortcut), title = COALESCE($3, title),
       body = COALESCE($4, body), category = COALESCE($5, category),
       enabled = COALESCE($6, enabled), updated_at = now()
     WHERE id = $1`,
    [id, shortcut || null, title || null, body || null, category ?? null,
     enabled === undefined ? null : enabled]
  );
  res.json({ success: true });
});

router.delete('/reply-templates/:id', async (req, res) => {
  await pg.query(`DELETE FROM crm_reply_templates WHERE id = $1`, [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ── Knowledge base topics (replaces static aiKnowledge.js) ───────────────────

router.get('/kb-topics', async (req, res) => {
  const includeDisabled = req.query.all === 'true';
  const { rows } = await pg.query(
    `SELECT id, topic, body, enabled, updated_at FROM crm_kb_topics
     ${includeDisabled ? '' : 'WHERE enabled = TRUE'} ORDER BY topic`
  );
  res.json({ success: true, items: rows });
});

router.post('/kb-topics', async (req, res) => {
  const { topic, body } = req.body || {};
  if (!topic || !body) return res.status(400).json({ success: false, message: 'topic, body required' });
  if (!/^[a-z0-9_]{2,64}$/.test(topic)) return res.status(400).json({ success: false, message: 'topic snake_case (2-64 chars)' });
  try {
    const r = await pg.query(
      `INSERT INTO crm_kb_topics (topic, body, updated_by) VALUES ($1, $2, $3) RETURNING id`,
      [topic, body, req.staff.staff_id]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'topic already exists' });
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/kb-topics/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { body, enabled, topic } = req.body || {};
  await pg.query(
    `UPDATE crm_kb_topics SET
       topic = COALESCE($2, topic), body = COALESCE($3, body),
       enabled = COALESCE($4, enabled),
       updated_at = now(), updated_by = $5
     WHERE id = $1`,
    [id, topic || null, body || null, enabled === undefined ? null : enabled, req.staff.staff_id]
  );
  res.json({ success: true });
});

router.delete('/kb-topics/:id', async (req, res) => {
  await pg.query(`DELETE FROM crm_kb_topics WHERE id = $1`, [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ── Promo settings (existing crm_promo_settings table — finally a CRUD UI) ──

router.get('/promos', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, code, description, product_category, city, discount_pct, discount_amount,
            starts_at, ends_at, active, created_at
     FROM crm_promo_settings ORDER BY active DESC, ends_at DESC`
  );
  res.json({ success: true, items: rows });
});

router.post('/promos', async (req, res) => {
  const { code, description, product_category, city, discount_pct, discount_amount,
          starts_at, ends_at, active } = req.body || {};
  if (!code || !description || !starts_at || !ends_at) {
    return res.status(400).json({ success: false, message: 'code, description, starts_at, ends_at required' });
  }
  try {
    const r = await pg.query(
      `INSERT INTO crm_promo_settings
         (code, description, product_category, city, discount_pct, discount_amount, starts_at, ends_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [code, description, product_category || null, city || null,
       discount_pct || null, discount_amount || null,
       starts_at, ends_at, active !== false]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'code already exists' });
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/promos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const f = req.body || {};
  await pg.query(
    `UPDATE crm_promo_settings SET
       code = COALESCE($2, code), description = COALESCE($3, description),
       product_category = COALESCE($4, product_category), city = COALESCE($5, city),
       discount_pct = COALESCE($6, discount_pct), discount_amount = COALESCE($7, discount_amount),
       starts_at = COALESCE($8, starts_at), ends_at = COALESCE($9, ends_at),
       active = COALESCE($10, active)
     WHERE id = $1`,
    [id, f.code || null, f.description || null, f.product_category ?? null, f.city ?? null,
     f.discount_pct ?? null, f.discount_amount ?? null,
     f.starts_at || null, f.ends_at || null,
     f.active === undefined ? null : f.active]
  );
  res.json({ success: true });
});

router.delete('/promos/:id', async (req, res) => {
  await pg.query(`DELETE FROM crm_promo_settings WHERE id = $1`, [parseInt(req.params.id)]);
  res.json({ success: true });
});

// ── KB drafts (auto-captured from low_confidence handovers) ────────────────
router.get('/kb-drafts', async (req, res) => {
  const status = req.query.status || 'pending';
  const { rows } = await pg.query(
    `SELECT d.id, d.conversation_id, d.message_id, d.question, d.suggested_answer,
            d.status, d.created_at, d.reviewed_at, d.reviewed_by, c.phone
     FROM crm_kb_drafts d
     LEFT JOIN crm_conversations c ON c.id = d.conversation_id
     WHERE d.status = $1
     ORDER BY d.created_at DESC LIMIT 100`,
    [status]
  );
  res.json({ success: true, items: rows });
});

router.post('/kb-drafts/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  const { topic, answer } = req.body || {};
  if (!topic || !answer) return res.status(400).json({ success: false, message: 'topic + answer required' });
  const slug = String(topic).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64);
  const t = await pg.query(
    `INSERT INTO crm_kb_topics (topic, body, enabled, updated_at, updated_by)
     VALUES ($1, $2, TRUE, now(), $3)
     ON CONFLICT (topic) DO UPDATE SET body = EXCLUDED.body, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING id`,
    [slug, String(answer), req.staff.staff_id]
  );
  await pg.query(
    `UPDATE crm_kb_drafts SET status = 'approved', approved_topic_id = $2,
       reviewed_at = now(), reviewed_by = $3 WHERE id = $1`,
    [id, t.rows[0].id, req.staff.staff_id]
  );
  res.json({ success: true, topic_id: t.rows[0].id });
});

router.post('/kb-drafts/:id/dismiss', async (req, res) => {
  const id = parseInt(req.params.id);
  await pg.query(
    `UPDATE crm_kb_drafts SET status = 'dismissed', reviewed_at = now(), reviewed_by = $2 WHERE id = $1`,
    [id, req.staff.staff_id]
  );
  res.json({ success: true });
});

// ── AI corrections log (operator edits AI-suggested draft before sending) ──
router.post('/ai-corrections', async (req, res) => {
  const { conversation_id, ai_suggested, operator_sent } = req.body || {};
  if (!conversation_id || !ai_suggested || !operator_sent) {
    return res.status(400).json({ success: false, message: 'conv_id + ai_suggested + operator_sent required' });
  }
  const tok = (s) => new Set(String(s).toLowerCase().split(/\W+/).filter((x) => x.length > 2));
  const a = tok(ai_suggested), b = tok(operator_sent);
  const inter = [...a].filter((x) => b.has(x)).length;
  const uni = new Set([...a, ...b]).size || 1;
  const sim = (inter / uni).toFixed(3);
  if (Number(sim) >= 0.95) return res.json({ success: true, skipped: 'no_meaningful_change', similarity: sim });
  await pg.query(
    `INSERT INTO crm_ai_corrections (conversation_id, staff_id, ai_suggested, operator_sent, similarity)
     VALUES ($1, $2, $3, $4, $5)`,
    [parseInt(conversation_id), req.staff.staff_id, String(ai_suggested), String(operator_sent), sim]
  );
  res.json({ success: true, similarity: sim });
});

router.get('/ai-corrections/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { rows } = await pg.query(
    `SELECT c.id, c.conversation_id, c.staff_id, c.ai_suggested, c.operator_sent, c.similarity, c.created_at,
            u.full_name AS staff_name
     FROM crm_ai_corrections c
     LEFT JOIN staff_users u ON u.id = c.staff_id
     ORDER BY c.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ success: true, items: rows });
});

module.exports = router;
