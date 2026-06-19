/**
 * Permanent cleanup: fix historical OUTBOUND rows in lotus `messages` whose
 * cust_number was wrongly set to the business number by the old lotus-tailer.
 * Sets cust_number = raw_doc.message.to (the real recipient/customer phone),
 * which is what inbound rows and newly-tailed outbound already use.
 *
 * After this, the simple `WHERE cust_number = phone` matches outbound too, so
 * any consumer (lotus-inbox, AR worksheet, AI context) sees the full thread
 * even without the raw_to fallback clause.
 *
 * Safe to re-run (idempotent — only touches rows still mismatched). Batched to
 * avoid a long table lock. Dry-run by default.
 *
 * Usage:
 *   node backfill_outbound_cust.js              # DRY RUN: just count
 *   node backfill_outbound_cust.js --apply      # perform the update, batched
 *   node backfill_outbound_cust.js --apply --batch 10000
 */
const lotus = require('./db/lotus');

const APPLY = process.argv.includes('--apply');
const bi = process.argv.indexOf('--batch');
const BATCH = bi >= 0 ? parseInt(process.argv[bi + 1], 10) : 5000;

const MATCH = `
  direction = 'outbound'
  AND raw_doc->'message'->>'to' IS NOT NULL
  AND raw_doc->'message'->>'to' <> ''
  AND cust_number IS DISTINCT FROM raw_doc->'message'->>'to'
`;

(async () => {
  const { rows: cnt } = await lotus.query(`SELECT count(*)::int n FROM messages WHERE ${MATCH}`);
  const total = cnt[0].n;
  console.log(`outbound rows with wrong cust_number: ${total}`);

  if (!APPLY) {
    const { rows: sample } = await lotus.query(
      `SELECT id, cust_number, raw_doc->'message'->>'to' AS should_be, left(body,30) body
       FROM messages WHERE ${MATCH} ORDER BY id DESC LIMIT 5`);
    sample.forEach((r) => console.log(`  #${r.id} cust=${r.cust_number} -> ${r.should_be} | ${r.body}`));
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to fix.');
    process.exit(0);
  }

  let fixedTotal = 0;
  for (;;) {
    const { rowCount } = await lotus.query(
      `UPDATE messages m
         SET cust_number = sub.rt
       FROM (
         SELECT id, raw_doc->'message'->>'to' AS rt
         FROM messages
         WHERE ${MATCH}
         ORDER BY id
         LIMIT ${BATCH}
       ) sub
       WHERE m.id = sub.id`);
    fixedTotal += rowCount;
    console.log(`  fixed batch: ${rowCount} (cumulative ${fixedTotal}/${total})`);
    if (rowCount === 0) break;
  }
  console.log(`done. total fixed: ${fixedTotal}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
