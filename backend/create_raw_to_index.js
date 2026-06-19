// Optional speed-up for the lotus-inbox conversation query.
// Creates a partial functional index so matching outbound rows by recipient
// phone (raw_doc.message.to) uses an index instead of a scan.
// Run:  node /home/krttpt/crm/backend/create_raw_to_index.js
const lotus = require('./db/lotus');
(async () => {
  const t = Date.now();
  await lotus.query(
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_out_raw_to_idx " +
    "ON messages ((raw_doc->'message'->>'to')) WHERE direction='outbound'"
  );
  const v = await lotus.query(
    "SELECT indexname FROM pg_indexes WHERE tablename='messages' AND indexname='messages_out_raw_to_idx'"
  );
  console.log(`index ${v.rows.length === 1 ? 'OK' : 'MISSING'} (${Date.now() - t} ms)`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
