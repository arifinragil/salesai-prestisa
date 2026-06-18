#!/usr/bin/env node
/**
 * One-off backfill: fix outbound messages stored 7h early in the lotus DB.
 *
 * Root cause: the external Lotus/Lavender writer inserts outbound HSM/auto-reply
 * rows with a NAIVE receivedAt string (no timezone), e.g. '2026-06-15 04:01:28'.
 * The lotus DB session runs TimeZone = Asia/Jakarta, so that naive string is cast
 * to timestamptz as WIB and stored 7h early (2026-06-14T21:01:28Z). The naive
 * string is actually UTC, so the correct value is that string read AS UTC.
 *
 * Affected rows are precisely identifiable by the naive-datetime pattern; the
 * original string is preserved in raw_doc, so this is recomputable and idempotent
 * (re-running sets the same value). Inbound (carries Z) and epoch-millis outbound
 * are untouched.
 *
 * Validated: 127,642 / 127,643 matched rows are exactly -7h vs their own
 * raw_doc.created_at (which carries Z).
 *
 * Usage:  node backend/backfill_outbound_tz.js [--dry]
 */
const lotus = require('./db/lotus');

const NAIVE_RE =
  "(raw_doc->>'receivedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?$'";

const WHERE = `direction = 'outbound' AND ${NAIVE_RE}`;

(async () => {
  const dry = process.argv.includes('--dry');
  const c = await lotus.query(`SELECT count(*)::int AS c FROM messages WHERE ${WHERE}`);
  console.log(`matched rows: ${c.rows[0].c}${dry ? ' (dry run, no write)' : ''}`);
  if (dry || c.rows[0].c === 0) {
    process.exit(0);
  }
  const client = await lotus.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE messages
          SET received_at = ((raw_doc->>'receivedAt') || 'Z')::timestamptz
        WHERE ${WHERE}`
    );
    await client.query('COMMIT');
    console.log(`updated rows: ${upd.rowCount}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
  }
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
