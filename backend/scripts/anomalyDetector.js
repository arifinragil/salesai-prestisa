// Anomaly detector — every 15 min. Compares last hour vs trailing 24h baseline.
// Alerts to Telegram on spike (≥3× baseline OR ≥5 absolute) for: complaint, refund,
// handover, send_failed. De-dup via crm_anomaly_events (1 alert per kind / hour).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pg = require('../db/postgres');
const settings = require('../services/settings');
const tg = require('../services/telegramNotify');
const logger = require('../services/logger');

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://salesai.prestisa.net';

async function checkKind({ kind, label, lastHourSql, baselineSql, params = [] }) {
  const last = (await pg.query(lastHourSql, params)).rows[0];
  const base = (await pg.query(baselineSql, params)).rows[0];
  const lastN = Number(last?.n || 0);
  const baseAvgPerHour = Number(base?.n || 0) / 24;
  const isSpike = lastN >= 5 && lastN >= Math.max(3 * baseAvgPerHour, 3);
  return { kind, label, lastN, baseAvgPerHour, isSpike };
}

async function run() {
  const enabled = await settings.getSetting('anomaly_alerts_enabled', true);
  if (enabled === false) { logger.info('[anomaly] disabled'); await pg.end(); return; }

  const checks = [
    {
      kind: 'complaint_spike', label: 'Komplain',
      lastHourSql: `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE reason='complaint' AND created_at > now() - interval '1 hour'`,
      baselineSql: `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE reason='complaint' AND created_at BETWEEN now() - interval '25 hours' AND now() - interval '1 hour'`,
    },
    {
      kind: 'refund_spike', label: 'Refund',
      lastHourSql: `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE reason='refund' AND created_at > now() - interval '1 hour'`,
      baselineSql: `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE reason='refund' AND created_at BETWEEN now() - interval '25 hours' AND now() - interval '1 hour'`,
    },
    {
      kind: 'handover_spike', label: 'Handover total',
      lastHourSql: `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at > now() - interval '1 hour'`,
      baselineSql: `SELECT COUNT(*)::int AS n FROM crm_handovers WHERE created_at BETWEEN now() - interval '25 hours' AND now() - interval '1 hour'`,
    },
    {
      kind: 'send_failed_spike', label: 'WAHA send_failed',
      lastHourSql: `SELECT COUNT(*)::int AS n FROM crm_messages WHERE direction='out' AND send_status='send_failed' AND created_at > now() - interval '1 hour'`,
      baselineSql: `SELECT COUNT(*)::int AS n FROM crm_messages WHERE direction='out' AND send_status='send_failed' AND created_at BETWEEN now() - interval '25 hours' AND now() - interval '1 hour'`,
    },
  ];

  for (const c of checks) {
    const r = await checkKind(c);
    if (!r.isSpike) continue;

    // Dedup: skip if same kind already alerted in last 60 min
    const dup = await pg.query(
      `SELECT 1 FROM crm_anomaly_events
       WHERE kind = $1 AND created_at > now() - interval '60 minutes' LIMIT 1`,
      [r.kind]
    );
    if (dup.rows.length) continue;

    const text = `🚨 <b>Anomaly: ${r.label}</b>\n` +
      `Jam terakhir: <b>${r.lastN}</b> kejadian\n` +
      `Baseline 24h: ~${r.baseAvgPerHour.toFixed(1)}/jam\n` +
      `${PUBLIC_URL}/ai-monitor`;
    const sent = await tg.send(text, { kind: 'anomaly' });
    await pg.query(
      `INSERT INTO crm_anomaly_events (kind, metric_value, threshold, window_label, detail)
       VALUES ($1, $2, $3, '1h', $4)`,
      [r.kind, r.lastN, r.baseAvgPerHour.toFixed(2), `telegram_ok=${sent.ok}`]
    );
    logger.warn({ kind: r.kind, lastN: r.lastN, base: r.baseAvgPerHour }, '[anomaly] alerted');
  }
  await pg.end();
}

if (require.main === module) {
  run().catch((err) => { logger.error({ err: err.message }, '[anomaly] failed'); process.exit(1); });
}

module.exports = { run };
