// Daily owner brief — runs at jam yang dikonfigurasi via cron.
// Mengirim digest 24h ke Telegram. Cron entry harus pakai jam yang sama dgn setting.
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const settings = require('../services/settings');
const tg = require('../services/telegramNotify');
const logger = require('../services/logger');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://salesai.prestisa.net';

async function run() {
  const enabled = await settings.getSetting('daily_brief_enabled', true);
  if (enabled === false) { logger.info('[brief] disabled'); await pg.end(); return; }

  const [overall, handovers, csat, cost, topReasons, conv, pipelineByStage, lostReasons] = await Promise.all([
    pg.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction='in') AS inbound,
        COUNT(*) FILTER (WHERE direction='out' AND sender_type='ai') AS ai_sent,
        COUNT(*) FILTER (WHERE direction='out' AND sender_type='staff') AS op_sent,
        COUNT(*) FILTER (WHERE direction='out' AND send_status='send_failed') AS send_failed,
        COUNT(DISTINCT conversation_id) AS active_convs
      FROM crm_messages WHERE created_at > now() - interval '24 hours'`),
    pg.query(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE resolved_at IS NULL) AS open
      FROM crm_handovers WHERE created_at > now() - interval '24 hours'`),
    pg.query(`
      SELECT ROUND(AVG(score)::numeric, 2) AS avg_score, COUNT(*) AS n
      FROM crm_csat WHERE collected_at > now() - interval '7 days'`),
    pg.query(`
      SELECT COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost
      FROM crm_ai_metrics_daily WHERE date = CURRENT_DATE - 1`),
    pg.query(`
      SELECT reason, COUNT(*) AS n
      FROM crm_handovers WHERE created_at > now() - interval '24 hours'
      GROUP BY reason ORDER BY n DESC LIMIT 5`),
    pg.query(`
      SELECT links_sent, orders_converted, COALESCE(revenue, 0)::bigint AS revenue FROM (
        SELECT
          (SELECT COUNT(*) FROM crm_conversations WHERE last_order_url_sent_at > now() - interval '24 hours') AS links_sent,
          0::int AS orders_converted,
          0::bigint AS revenue
      ) t`),
    pg.query(`
      SELECT pipeline_stage, COUNT(*)::int AS n FROM crm_conversations
      WHERE pipeline_stage NOT IN ('delivered','lost')
         OR pipeline_stage_at > now() - interval '7 days'
      GROUP BY pipeline_stage`),
    pg.query(`
      SELECT lost_reason, COUNT(*)::int AS n FROM crm_conversations
      WHERE pipeline_stage = 'lost' AND pipeline_stage_at > now() - interval '24 hours' AND lost_reason IS NOT NULL
      GROUP BY lost_reason ORDER BY n DESC LIMIT 3`),
  ]);

  const o = overall.rows[0];
  const h = handovers.rows[0];
  const cs = csat.rows[0];
  const yC = cost.rows[0];
  const cv = conv.rows[0];

  const reasonsTxt = topReasons.rows.length
    ? topReasons.rows.map((r) => `  • ${r.reason}: ${r.n}`).join('\n')
    : '  (tidak ada handover)';

  const pipelineLines = pipelineByStage.rows.length
    ? pipelineByStage.rows.map((r) => `  • ${r.pipeline_stage}: ${r.n}`).join('\n')
    : '  (kosong)';
  const lostLines = lostReasons.rows.length
    ? lostReasons.rows.map((r) => `  • ${r.lost_reason}: ${r.n}`).join('\n')
    : '  (tidak ada)';

  const body =
`🌷 <b>Tiara CRM — daily brief</b>
${new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' })}

📥 <b>Aktivitas 24h</b>
• Inbound: ${o.inbound} pesan
• AI sent: ${o.ai_sent} · Operator: ${o.op_sent}
• Active conv: ${o.active_convs}
${Number(o.send_failed) > 0 ? `• ⚠️ Send failed: ${o.send_failed}` : ''}

🤝 <b>Handover</b>
• Total: ${h.total} · Open: ${h.open}
${reasonsTxt}

😊 <b>CSAT 7d</b>: ${cs.avg_score || '-'} (${cs.n || 0} responses)
💰 <b>AI cost kemarin</b>: $${Number(yC.cost).toFixed(4)}
🔗 <b>Order link sent</b>: ${cv.links_sent}

🎯 <b>Pipeline today</b>
${pipelineLines}

😞 <b>Top Lost reason 24h</b>
${lostLines}

${PUBLIC_URL}/ai-monitor`;

  const r = await tg.send(body, { kind: 'brief' });
  logger.info({ telegram_ok: r.ok }, '[brief] sent');
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[brief] failed'); process.exit(1); });
}

module.exports = { run };
