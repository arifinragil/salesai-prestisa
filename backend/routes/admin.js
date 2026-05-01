const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const settingsSvc = require('../services/settings');
const costGuard = require('../services/costGuard');
const aiClient = require('../services/aiClient');
const sqlQueries = require('../services/sqlQueries');

const router = express.Router();
router.use(requireStaff);

// ── Settings ─────────────────────────────────────────────────────────────────

const ALLOWED_SETTING_KEYS = new Set([
  'daily_cost_cap_usd',
  'shadow_mode_default',
  'reply_provider',
  'ai_credentials',
  'handover_webhook',
]);

router.get('/settings', async (_req, res) => {
  const items = await settingsSvc.listSettings();
  // Mask api_keys in ai_credentials before returning
  const masked = items.map((it) => {
    if (it.key === 'ai_credentials' && it.value && typeof it.value === 'object') {
      const m = {};
      for (const provider of Object.keys(it.value)) {
        const cfg = it.value[provider] || {};
        m[provider] = {
          api_key_set: !!cfg.api_key,
          api_key_preview: cfg.api_key ? cfg.api_key.slice(0, 7) + '…' + cfg.api_key.slice(-4) : null,
          model: cfg.model || null,
        };
      }
      return { ...it, value: m };
    }
    return it;
  });
  res.json({ success: true, items: masked });
});

router.get('/ai/provider', async (_req, res) => {
  const status = await aiClient.getActiveStatus();
  res.json({ success: true, ...status, valid_providers: aiClient.VALID_PROVIDERS });
});

// ── SQL queries (named templates AI can run via run_named_query tool) ──────

router.get('/sql-queries', async (_req, res) => {
  res.json({ success: true, items: await sqlQueries.listAll() });
});

router.post('/sql-queries', async (req, res) => {
  const { name, description, params, sql_text, row_limit } = req.body || {};
  if (!name || !description || !sql_text) {
    return res.status(400).json({ success: false, message: 'name, description, sql_text required' });
  }
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) {
    return res.status(400).json({ success: false, message: 'name must be snake_case (a-z0-9_, 3-64 chars)' });
  }
  try {
    const out = await sqlQueries.create({ name, description, params: params || [], sql_text, row_limit, created_by: req.staff.staff_id });
    res.json({ success: true, id: out.id });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.put('/sql-queries/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  try {
    await sqlQueries.update(id, req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.delete('/sql-queries/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  await sqlQueries.remove(id);
  res.json({ success: true });
});

router.post('/sql-queries/test', async (req, res) => {
  const { name, params } = req.body || {};
  if (!name) return res.status(400).json({ success: false, message: 'name required' });
  try {
    const out = await sqlQueries.run(name, params || {});
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/ai/models', async (req, res) => {
  const provider = String(req.query.provider || '').toLowerCase();
  if (!aiClient.VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ success: false, message: `provider must be one of: ${aiClient.VALID_PROVIDERS.join(', ')}` });
  }
  try {
    const out = await aiClient.listProviderModels(provider);
    if (out.error) return res.status(502).json({ success: false, message: out.error });
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

router.put('/settings/:key', async (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_SETTING_KEYS.has(key)) {
    return res.status(400).json({ success: false, message: `setting "${key}" not allowed` });
  }
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) {
    return res.status(400).json({ success: false, message: 'body.value required' });
  }
  let value = req.body.value;
  if (key === 'daily_cost_cap_usd') {
    const n = parseFloat(value);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'value must be non-negative number' });
    value = n;
  } else if (key === 'shadow_mode_default') {
    value = !!value;
  } else if (key === 'handover_webhook') {
    if (!value || typeof value !== 'object') {
      return res.status(400).json({ success: false, message: 'value must be object {url, enabled, reasons}' });
    }
    if (value.url && !/^https?:\/\//.test(value.url)) {
      return res.status(400).json({ success: false, message: 'url must be http(s)' });
    }
  } else if (key === 'reply_provider') {
    if (!aiClient.VALID_PROVIDERS.includes(value)) {
      return res.status(400).json({ success: false, message: `provider must be one of: ${aiClient.VALID_PROVIDERS.join(', ')}` });
    }
  } else if (key === 'ai_credentials') {
    if (!value || typeof value !== 'object') {
      return res.status(400).json({ success: false, message: 'value must be object {provider: {api_key, model}}' });
    }
    // Merge with existing so user can update one provider without losing others.
    // If a field is empty string/null in incoming, keep existing.
    const existing = (await settingsSvc.getSetting('ai_credentials', {})) || {};
    const merged = { ...existing };
    for (const provider of Object.keys(value)) {
      if (!aiClient.VALID_PROVIDERS.includes(provider)) continue;
      const incoming = value[provider] || {};
      const prev = existing[provider] || {};
      merged[provider] = {
        api_key: (incoming.api_key && String(incoming.api_key).trim()) || prev.api_key || null,
        model: (incoming.model && String(incoming.model).trim()) || prev.model || null,
      };
    }
    value = merged;
  }
  await settingsSvc.setSetting(key, value, req.staff.staff_id);
  res.json({ success: true, key, masked: key === 'ai_credentials' ? true : false });
});

router.get('/cost/today', async (_req, res) => {
  const r = await costGuard.checkCap();
  res.json({ success: true, ...r });
});

router.get('/cost/breakdown', async (_req, res) => {
  const r = await costGuard.getTodayBreakdown();
  res.json({ success: true, ...r });
});

router.post('/webhook/test', async (req, res) => {
  const url = (req.body?.url || '').toString();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ success: false, message: 'invalid url' });
  try {
    const text = '✅ Test webhook dari Tiara CRM (handover notif). Kalau pesan ini sampai, integrasi berhasil.';
    const body = /discord\.com\/api\/webhooks/.test(url) ? { content: text } : { text };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(502).json({ success: false, message: `${r.status}: ${txt.slice(0, 200)}` });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(502).json({ success: false, message: err.message });
  }
});

// ── Persona ──────────────────────────────────────────────────────────────────

router.get('/personas', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT id, name, active, created_by, created_at,
            LEFT(prompt_text, 200) AS preview
     FROM crm_persona_prompts ORDER BY id DESC LIMIT 50`
  );
  res.json({ success: true, items: rows });
});

router.get('/personas/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT id, name, prompt_text, active, created_by, created_at FROM crm_persona_prompts WHERE id = $1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  res.json({ success: true, persona: rows[0] });
});

router.post('/personas', async (req, res) => {
  const { name, prompt_text } = req.body || {};
  if (!name || !prompt_text) return res.status(400).json({ success: false, message: 'name and prompt_text required' });
  const { rows } = await pg.query(
    `INSERT INTO crm_persona_prompts (name, prompt_text, active, created_by)
     VALUES ($1, $2, FALSE, $3) RETURNING id`,
    [name, prompt_text, req.staff.staff_id]
  );
  res.json({ success: true, id: rows[0].id });
});

router.post('/personas/:id/activate', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'invalid id' });
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE crm_persona_prompts SET active = FALSE WHERE active = TRUE`);
    const r = await client.query(`UPDATE crm_persona_prompts SET active = TRUE WHERE id = $1 RETURNING id`, [id]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'persona not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true, active_id: id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ── Global toggles ───────────────────────────────────────────────────────────

router.post('/ai/global', (req, res) => {
  const enabled = !!req.body?.enabled;
  process.env.AI_GLOBAL_ENABLED = enabled ? 'true' : 'false';
  res.json({ success: true, enabled });
});

router.get('/ai/global', (_req, res) => {
  const enabled = String(process.env.AI_GLOBAL_ENABLED || 'true').toLowerCase() !== 'false';
  res.json({ success: true, enabled });
});

// ── Metrics ──────────────────────────────────────────────────────────────────

router.get('/metrics/today', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const [queue, inbound, ai_sent, handovers] = await Promise.all([
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_inbound_queue WHERE status = 'pending'`),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_messages WHERE direction = 'in' AND created_at::date = $1`, [today]),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_messages WHERE sender_type = 'ai' AND shadow = FALSE AND created_at::date = $1`, [today]),
    pg.query(`SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at::date = $1`, [today]),
  ]);
  res.json({
    success: true,
    metrics: {
      date: today,
      queue_depth: queue.rows[0].n,
      inbound_today: inbound.rows[0].n,
      ai_sent_today: ai_sent.rows[0].n,
      handovers_today: handovers.rows[0].n,
    },
  });
});

router.get('/metrics/recent', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT date, total_inbound, total_ai_sent, total_handovers, unique_conversations,
            avg_latency_ms, total_tokens_in, total_tokens_out, cost_usd, handover_breakdown
     FROM crm_ai_metrics_daily ORDER BY date DESC LIMIT 30`
  );
  res.json({ success: true, items: rows });
});

router.get('/metrics/handover-breakdown', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const { rows } = await pg.query(
    `SELECT reason, COUNT(*)::int AS n
     FROM crm_handovers
     WHERE created_at >= now() - INTERVAL '${days} days'
     GROUP BY reason ORDER BY n DESC`
  );
  res.json({ success: true, breakdown: rows, days });
});

module.exports = router;
