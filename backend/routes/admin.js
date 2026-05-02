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
  'ai_global_enabled',
  'telegram_bot_token',
  'telegram_chat_id',
  'telegram_chat_sla',
  'telegram_chat_anomaly',
  'telegram_chat_brief',
  'sla_handover_minutes',
  'daily_brief_enabled',
  'daily_brief_time',
  'anomaly_alerts_enabled',
  'claim_lease_minutes',
  'spam_filter_enabled',
  'ai_mode',                          // auto | copilot
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
  } else if (key === 'ai_mode') {
    if (!['auto', 'copilot'].includes(value)) {
      return res.status(400).json({ success: false, message: "ai_mode must be 'auto' or 'copilot'" });
    }
  }
  await settingsSvc.setSetting(key, value, req.staff.staff_id);
  res.json({ success: true, key, masked: key === 'ai_credentials' ? true : false });
});

router.get('/settings/audit', async (_req, res) => {
  const items = await settingsSvc.listAudit(100);
  res.json({ success: true, items });
});

router.post('/telegram/test', async (req, res) => {
  const tg = require('../services/telegramNotify');
  const kind = ['sla', 'anomaly', 'brief'].includes(req.body?.kind) ? req.body.kind : null;
  const me = await tg.getMe();
  if (!me.ok) return res.status(400).json({ success: false, message: me.error });
  const label = kind ? ` (channel: ${kind})` : ' (channel: default)';
  const send = await tg.send(
    `✅ Tiara CRM test${label} — bot @${me.username}\nWaktu: ${new Date().toLocaleString('id-ID')}`,
    { kind }
  );
  if (!send.ok) return res.status(400).json({ success: false, message: send.error || send.skipped || 'send failed', bot: me });
  res.json({ success: true, bot: me, sent_message_id: send.message_id, chat_id: send.chat_id });
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

// Persist to crm_pilot_settings so toggle survives backend restart.
// Process env still updated for back-compat with existing reads in same proc.
router.post('/ai/global', async (req, res) => {
  const enabled = !!req.body?.enabled;
  await settingsSvc.setSetting('ai_global_enabled', enabled, req.staff.staff_id);
  process.env.AI_GLOBAL_ENABLED = enabled ? 'true' : 'false';
  res.json({ success: true, enabled });
});

router.get('/ai/global', async (_req, res) => {
  const stored = await settingsSvc.getSetting('ai_global_enabled', null);
  // Falls back to env var if DB never set (fresh install)
  const enabled = stored != null
    ? !!stored
    : String(process.env.AI_GLOBAL_ENABLED || 'true').toLowerCase() !== 'false';
  res.json({ success: true, enabled, persisted: stored != null });
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

// ── Eval runner ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const evalRunner = require('../scripts/runEval');
const personaSvc = require('../services/aiPersona');

router.post('/eval/run', async (req, res) => {
  try {
    const cases = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'scripts', 'evalCases.json'), 'utf8')
    );
    const systemPrompt = await personaSvc.buildSystemPrompt({
      conv: { id: 0, phone: '628000000000', customer_id: null, last_intent: null },
      customerName: null, cityHint: null,
    });
    const results = [];
    for (const c of cases) {
      try {
        results.push(await evalRunner.runOne(c, systemPrompt));
      } catch (err) {
        results.push({ id: c.id, passed: false, reasons: [`unhandled: ${err.message}`] });
      }
    }
    const passed = results.filter((r) => r.passed).length;
    const rate = (passed / results.length) * 100;
    const ins = await pg.query(
      `INSERT INTO crm_eval_runs (ran_by, total, passed, pass_rate, details)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, ran_at`,
      [req.staff.staff_id, results.length, passed, rate.toFixed(2), JSON.stringify(results)]
    );
    res.json({ success: true, run_id: ins.rows[0].id, ran_at: ins.rows[0].ran_at,
              total: results.length, passed, pass_rate: rate.toFixed(2), results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/eval/runs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { rows } = await pg.query(
    `SELECT id, ran_at, ran_by, total, passed, pass_rate
     FROM crm_eval_runs ORDER BY ran_at DESC LIMIT $1`, [limit]
  );
  res.json({ success: true, items: rows });
});

router.get('/eval/runs/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pg.query(
    `SELECT id, ran_at, total, passed, pass_rate, details FROM crm_eval_runs WHERE id = $1`, [id]
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'not found' });
  res.json({ success: true, run: rows[0] });
});

// #11 Response time heatmap — avg time from inbound to AI reply, per hour×weekday
router.get('/heatmap/response-time', async (_req, res) => {
  const { rows } = await pg.query(`
    WITH pairs AS (
      SELECT m_in.created_at AS in_at,
             MIN(m_out.created_at) AS out_at
      FROM crm_messages m_in
      JOIN crm_messages m_out ON m_out.conversation_id = m_in.conversation_id
        AND m_out.id > m_in.id
        AND m_out.direction = 'out'
        AND m_out.sender_type IN ('ai','staff')
        AND m_out.created_at < m_in.created_at + interval '30 minutes'
      WHERE m_in.direction = 'in'
        AND m_in.created_at > now() - interval '14 days'
      GROUP BY m_in.id, m_in.created_at
    )
    SELECT EXTRACT(DOW FROM in_at)::int  AS dow,
           EXTRACT(HOUR FROM in_at)::int AS hour,
           ROUND(AVG(EXTRACT(EPOCH FROM (out_at - in_at)))::numeric, 1) AS avg_seconds,
           COUNT(*) AS n
    FROM pairs
    GROUP BY dow, hour ORDER BY dow, hour
  `);
  res.json({ success: true, items: rows });
});

// #1 AI conversion attribution — orders that came from AI conv UTM
router.get('/conversion/attribution', async (_req, res) => {
  // Match crm_conversations.last_order_url_ref → MySQL order utm_content
  // (assumes order table has a utm_content column or similar; if not, skip)
  try {
    const { rows: convs } = await pg.query(`
      SELECT id, phone, last_order_url_sent_at, last_order_url_ref
      FROM crm_conversations
      WHERE last_order_url_ref IS NOT NULL
        AND last_order_url_sent_at > now() - interval '30 days'
    `);
    const refs = convs.map((c) => c.last_order_url_ref).filter(Boolean);
    let conversions = [];
    if (refs.length) {
      const mysql = require('../db/mysql');
      // Try utm_content column; if missing, return empty (graceful)
      try {
        const [rows] = await mysql.query(
          `SELECT id, order_number, total, status, payment_status, created_at, utm_content
           FROM \`order\` WHERE utm_content IN (?) AND deleted_at IS NULL
           ORDER BY id DESC`,
          [refs]
        );
        conversions = rows;
      } catch (err) {
        return res.json({ success: true, conversions: [], note: 'order.utm_content column belum ada — perlu schema MySQL', sent_links: convs.length });
      }
    }
    const totalSent = convs.length;
    const totalConverted = conversions.length;
    const totalRevenue = conversions.reduce((s, o) => s + Number(o.total || 0), 0);
    // Funnel stages from crm_link_events
    const { rows: funnelRows } = await pg.query(`
      SELECT event, COUNT(DISTINCT ref)::int AS n
      FROM crm_link_events WHERE created_at > now() - interval '30 days'
      GROUP BY event`);
    const funnel = { click: 0, form_loaded: 0, submitted: 0 };
    for (const r of funnelRows) funnel[r.event] = r.n;
    res.json({
      success: true,
      summary: {
        links_sent_30d: totalSent,
        orders_converted: totalConverted,
        conversion_rate: totalSent ? (totalConverted / totalSent * 100).toFixed(1) : 0,
        revenue_idr: totalRevenue,
      },
      funnel,
      conversions: conversions.slice(0, 50),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// #9 Cohort retention — customers first-handled by AI vs Operator (90d back)
router.get('/cohort-retention', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 90, 180);
  // 1) For each conversation, identify the FIRST outbound (AI vs staff)
  // 2) Map conv → customer_id (must be linked, otherwise skip)
  // 3) Track if same customer placed paid orders 30/60/90d AFTER first contact
  const { rows: convs } = await pg.query(`
    SELECT DISTINCT ON (c.customer_id)
           c.customer_id,
           m.created_at AS first_out_at,
           m.sender_type
    FROM crm_conversations c
    JOIN crm_messages m ON m.conversation_id = c.id
      AND m.direction = 'out' AND m.sender_type IN ('ai','staff')
    WHERE c.customer_id IS NOT NULL
      AND m.created_at > now() - ($1 || ' days')::interval
    ORDER BY c.customer_id, m.id ASC
  `, [String(days)]);

  if (!convs.length) return res.json({ success: true, cohorts: [] });

  const aiCust = convs.filter((c) => c.sender_type === 'ai').map((c) => ({ id: c.customer_id, t0: c.first_out_at }));
  const opCust = convs.filter((c) => c.sender_type === 'staff').map((c) => ({ id: c.customer_id, t0: c.first_out_at }));

  async function compute(label, list) {
    if (!list.length) return { label, total: 0 };
    const mysql = require('../db/mysql');
    const ids = list.map((x) => x.id);
    const t0Map = new Map(list.map((x) => [x.id, x.t0]));
    let r30 = 0, r60 = 0, r90 = 0;
    try {
      const [orders] = await mysql.query(
        `SELECT customer_id, created_at FROM \`order\`
         WHERE customer_id IN (?) AND payment_status = 'paid' AND deleted_at IS NULL
           AND created_at > NOW() - INTERVAL 180 DAY`,
        [ids]
      );
      const byCust = new Map();
      for (const o of orders) {
        const arr = byCust.get(o.customer_id) || [];
        arr.push(new Date(o.created_at).getTime());
        byCust.set(o.customer_id, arr);
      }
      for (const c of list) {
        const t0 = new Date(c.t0).getTime();
        const cuOrders = byCust.get(c.id) || [];
        const after = cuOrders.filter((t) => t > t0);
        if (after.some((t) => t - t0 < 30 * 86400000)) r30++;
        if (after.some((t) => t - t0 < 60 * 86400000)) r60++;
        if (after.some((t) => t - t0 < 90 * 86400000)) r90++;
      }
    } catch (err) {
      return { label, total: list.length, error: err.message };
    }
    const pct = (n) => Math.round((n / list.length) * 1000) / 10;
    return {
      label, total: list.length,
      repeat_30d: r30, repeat_30d_pct: pct(r30),
      repeat_60d: r60, repeat_60d_pct: pct(r60),
      repeat_90d: r90, repeat_90d_pct: pct(r90),
    };
  }

  const cohorts = await Promise.all([compute('AI', aiCust), compute('operator', opCust)]);
  res.json({ success: true, cohorts });
});

// #6 Operator performance — last 30d per-staff summary
router.get('/operator-performance', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const { rows } = await pg.query(`
    WITH op_msgs AS (
      SELECT staff_id,
             COUNT(*) AS sent_n,
             AVG(EXTRACT(EPOCH FROM (m.created_at - prev_in.created_at))) AS avg_response_sec
      FROM crm_messages m
      LEFT JOIN LATERAL (
        SELECT created_at FROM crm_messages prev
        WHERE prev.conversation_id = m.conversation_id
          AND prev.direction = 'in'
          AND prev.created_at < m.created_at
        ORDER BY prev.id DESC LIMIT 1
      ) prev_in ON TRUE
      WHERE m.direction='out' AND m.sender_type='staff'
        AND m.created_at > now() - ($1 || ' days')::interval
      GROUP BY staff_id
    ),
    closed AS (
      SELECT resolved_by AS staff_id, COUNT(*) AS resolved_n
      FROM crm_handovers WHERE resolved_at > now() - ($1 || ' days')::interval AND resolved_by IS NOT NULL
      GROUP BY resolved_by
    ),
    corr AS (
      SELECT staff_id, COUNT(*) AS corrections, AVG(similarity)::numeric(4,3) AS avg_sim
      FROM crm_ai_corrections WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY staff_id
    ),
    csat_op AS (
      SELECT m.staff_id,
             AVG(cs.score)::numeric(3,2) AS avg_csat,
             COUNT(cs.id) AS csat_n
      FROM crm_csat cs
      JOIN crm_messages m ON m.conversation_id = cs.conversation_id
        AND m.direction='out' AND m.sender_type='staff'
        AND m.created_at < cs.collected_at AND m.created_at > cs.collected_at - interval '24 hours'
      WHERE cs.collected_at > now() - ($1 || ' days')::interval
      GROUP BY m.staff_id
    )
    SELECT u.id, u.username, u.full_name, u.role,
           COALESCE(op_msgs.sent_n, 0)::int AS sent_n,
           COALESCE(ROUND(op_msgs.avg_response_sec)::int, 0) AS avg_response_sec,
           COALESCE(closed.resolved_n, 0)::int AS handovers_resolved,
           COALESCE(corr.corrections, 0)::int AS ai_corrections,
           corr.avg_sim AS avg_correction_sim,
           csat_op.avg_csat,
           COALESCE(csat_op.csat_n, 0)::int AS csat_n
    FROM staff_users u
    LEFT JOIN op_msgs ON op_msgs.staff_id = u.id
    LEFT JOIN closed ON closed.staff_id = u.id
    LEFT JOIN corr ON corr.staff_id = u.id
    LEFT JOIN csat_op ON csat_op.staff_id = u.id
    WHERE u.active = TRUE AND u.disabled_at IS NULL
    ORDER BY sent_n DESC
  `, [String(days)]);
  res.json({ success: true, days, items: rows });
});

// #9 AI reply quality scores
router.get('/ai-quality/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const { rows: recent } = await pg.query(
    `SELECT s.id, s.message_id, s.conversation_id, s.scored_at, s.relevance, s.tone, s.factual,
            s.overall, s.reasoning, m.body
     FROM crm_ai_quality_scores s
     LEFT JOIN crm_messages m ON m.id = s.message_id
     ORDER BY s.scored_at DESC LIMIT $1`, [limit]
  );
  const { rows: stats } = await pg.query(
    `SELECT COUNT(*) AS n,
            ROUND(AVG(overall)::numeric, 2) AS avg_overall,
            ROUND(AVG(relevance)::numeric, 2) AS avg_relevance,
            ROUND(AVG(tone)::numeric, 2) AS avg_tone,
            ROUND(AVG(factual)::numeric, 2) AS avg_factual
     FROM crm_ai_quality_scores
     WHERE scored_at > now() - interval '30 days'`
  );
  res.json({ success: true, stats_30d: stats[0], recent });
});

// ── WA send health (block-rate proxy + rate-limit hits last 24h) ────────────
router.get('/wa-health', async (_req, res) => {
  const [overall, byConv, rateLimits] = await Promise.all([
    pg.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction='out' AND created_at > now() - interval '24 hours') AS sent_24h,
        COUNT(*) FILTER (WHERE direction='out' AND send_status='send_failed' AND created_at > now() - interval '24 hours') AS failed_24h
      FROM crm_messages
    `),
    pg.query(`
      SELECT m.conversation_id, c.phone, c.wa_session,
             COUNT(*) FILTER (WHERE m.send_status='send_failed') AS failures,
             COUNT(*) AS attempts,
             MAX(m.created_at) AS last_attempt
      FROM crm_messages m
      JOIN crm_conversations c ON c.id = m.conversation_id
      WHERE m.direction='out' AND m.created_at > now() - interval '24 hours'
      GROUP BY m.conversation_id, c.phone, c.wa_session
      HAVING COUNT(*) FILTER (WHERE m.send_status='send_failed') >= 2
      ORDER BY failures DESC LIMIT 20
    `),
    pg.query(`
      SELECT reason, COUNT(*)::int AS n
      FROM crm_handovers
      WHERE created_at > now() - interval '24 hours'
        AND detail ~* '(rate_limit|send_cap|opt-out|optout)'
      GROUP BY reason
    `),
  ]);
  const o = overall.rows[0];
  const failRate = o.sent_24h > 0 ? (Number(o.failed_24h) / Number(o.sent_24h)) * 100 : 0;
  res.json({
    success: true,
    overall: {
      sent_24h: Number(o.sent_24h),
      failed_24h: Number(o.failed_24h),
      fail_rate_pct: failRate.toFixed(2),
      health: failRate < 1 ? 'good' : failRate < 5 ? 'warning' : 'critical',
    },
    suspect_blocked: byConv.rows,
    rate_limit_hits_24h: rateLimits.rows,
  });
});

// ── Conversation timeline (24h hourly buckets, for monitor) ─────────────────
router.get('/timeline/24h', async (_req, res) => {
  const { rows } = await pg.query(`
    SELECT date_trunc('hour', m.created_at) AS hour,
           COUNT(*) FILTER (WHERE m.direction='in') AS inbound,
           COUNT(*) FILTER (WHERE m.direction='out' AND m.sender_type='ai') AS ai_out,
           COUNT(*) FILTER (WHERE m.direction='out' AND m.sender_type='staff') AS staff_out,
           COUNT(DISTINCT m.conversation_id) FILTER (WHERE m.direction='in') AS active_convs
    FROM crm_messages m
    WHERE m.created_at > now() - interval '24 hours'
    GROUP BY 1 ORDER BY 1
  `);
  res.json({ success: true, items: rows });
});

// ── A/B persona experiment management ───────────────────────────────────────
router.get('/experiments', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT e.*, pa.name AS variant_a_name, pb.name AS variant_b_name
     FROM crm_persona_experiments e
     JOIN crm_persona_prompts pa ON pa.id = e.variant_a
     JOIN crm_persona_prompts pb ON pb.id = e.variant_b
     ORDER BY enabled DESC, created_at DESC`
  );
  res.json({ success: true, items: rows });
});

router.post('/experiments', async (req, res) => {
  const { name, variant_a, variant_b, split_pct } = req.body || {};
  if (!name || !variant_a || !variant_b) return res.status(400).json({ success: false, message: 'name, variant_a, variant_b required' });
  if (variant_a === variant_b) return res.status(400).json({ success: false, message: 'variants must differ' });
  const pct = parseInt(split_pct) || 50;
  try {
    const r = await pg.query(
      `INSERT INTO crm_persona_experiments (name, variant_a, variant_b, split_pct, enabled)
       VALUES ($1, $2, $3, $4, FALSE) RETURNING id`,
      [name, variant_a, variant_b, pct]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.post('/experiments/:id/enable', async (req, res) => {
  const id = parseInt(req.params.id);
  await pg.query('BEGIN');
  try {
    await pg.query(`UPDATE crm_persona_experiments SET enabled = FALSE`);
    await pg.query(`UPDATE crm_persona_experiments SET enabled = TRUE WHERE id = $1`, [id]);
    await pg.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pg.query('ROLLBACK');
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post('/experiments/disable-all', async (_req, res) => {
  await pg.query(`UPDATE crm_persona_experiments SET enabled = FALSE`);
  res.json({ success: true });
});

router.delete('/experiments/:id', async (req, res) => {
  await pg.query(`DELETE FROM crm_persona_experiments WHERE id = $1`, [parseInt(req.params.id)]);
  res.json({ success: true });
});

router.get('/experiments/results', async (_req, res) => {
  // Outcome metric: avg CSAT + AI feedback score per variant for active experiment
  const { rows } = await pg.query(`
    SELECT c.experiment_variant AS variant,
           COUNT(DISTINCT c.id) AS conversations,
           AVG(cs.score)::numeric(3,2) AS avg_csat,
           COUNT(cs.id) AS csat_n,
           SUM(CASE WHEN m.feedback = 1 THEN 1 ELSE 0 END) AS thumbs_up,
           SUM(CASE WHEN m.feedback = -1 THEN 1 ELSE 0 END) AS thumbs_down
    FROM crm_conversations c
    LEFT JOIN crm_csat cs ON cs.conversation_id = c.id
    LEFT JOIN crm_messages m ON m.conversation_id = c.id AND m.sender_type='ai'
    WHERE c.experiment_variant IS NOT NULL
    GROUP BY c.experiment_variant
    ORDER BY c.experiment_variant
  `);
  res.json({ success: true, items: rows });
});

module.exports = router;
