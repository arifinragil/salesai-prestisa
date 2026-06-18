// backend/cron_penyebab_analyze.js
// Nightly batch: analyze non-closing leads that haven't been analyzed yet.
//
// Candidate query: crm_lotus_state leads whose status is NOT closed/won,
// with inbound_count >= 4, and NOT already in crm_lead_penyebab.
// Cap: SAFETY_LIMIT rows. Concurrency: CONCURRENCY (sequential batches).
//
// Run: node cron_penyebab_analyze.js
// Or:  require('./cron_penyebab_analyze').run()
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pg = require('./db/postgres');
const lotusPg = require('./db/lotus');
const { analyzeLead } = require('./services/penyebabAnalyze');
const { getClosingPhoneSet, normalizePhone } = require('./services/orderMatch');

const CONCURRENCY = 4;
const SLEEP_MS = 200;
const SAFETY_LIMIT = 500;
const MIN_INBOUND = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function findCandidates() {
  // Select active leads with enough inbound messages that aren't analyzed yet.
  // crm_lotus_state.lotus_id joined with lotus contacts for inbound count,
  // then filtered by NOT EXISTS in crm_lead_penyebab.
  //
  // Two-DB strategy: crm_lotus_state lives in crm (pg), contacts/messages live
  // in lotus (lotusPg). We pull state candidates from crm, then check inbound
  // count in lotus, then exclude already-analyzed from crm.
  const stateRows = (await pg.query(`
    SELECT cls.lotus_id
      FROM crm_lotus_state cls
     WHERE cls.status NOT IN ('closed', 'won')
       AND NOT EXISTS (
         SELECT 1 FROM crm_lead_penyebab lp WHERE lp.lotus_id = cls.lotus_id
       )
     LIMIT $1
  `, [SAFETY_LIMIT * 5])).rows; // over-fetch to allow inbound filter

  if (!stateRows.length) return [];

  const lotusIds = stateRows.map(r => r.lotus_id);

  // Get cust_number + business_number from lotus contacts
  const contacts = (await lotusPg.query(`
    SELECT lotus_id, cust_number, business_number
      FROM contacts
     WHERE lotus_id = ANY($1::text[])
  `, [lotusIds])).rows;

  if (!contacts.length) return [];

  // Check inbound message counts in lotus
  const custPairs = contacts.map(c => [c.cust_number, c.business_number]);
  // Build filter: (cust_number, business_number) IN (...)
  const values = custPairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  const flatPairs = custPairs.flat();

  const inboundCounts = (await lotusPg.query(`
    SELECT cust_number, business_number, COUNT(*) AS cnt
      FROM messages
     WHERE direction = 'inbound'
       AND (cust_number, business_number) IN (${values})
     GROUP BY cust_number, business_number
  `, flatPairs)).rows;

  const inboundMap = new Map(
    inboundCounts.map(r => [`${r.cust_number}|${r.business_number}`, parseInt(r.cnt, 10)])
  );

  // Filter contacts with enough inbound messages
  const qualified = contacts.filter(c => {
    const cnt = inboundMap.get(`${c.cust_number}|${c.business_number}`) ?? 0;
    return cnt >= MIN_INBOUND;
  });

  if (!qualified.length) return [];

  // "Tidak closing" = the phone has NO real (non-cancelled) order in the POS.
  // Drop any contact whose phone closed — we only analyze non-closing leads.
  const closingSet = await getClosingPhoneSet(qualified.map(c => c.cust_number));
  const nonClosing = qualified.filter(c => {
    const n = normalizePhone(c.cust_number);
    return n != null && !closingSet.has(n);
  });
  console.log(
    `penyebab_analyze: ${qualified.length} qualified, ${qualified.length - nonClosing.length} closed (skipped), ${nonClosing.length} non-closing`
  );

  return nonClosing.slice(0, SAFETY_LIMIT);
}

async function run() {
  const startedAt = Date.now();
  console.log('penyebab_analyze cron: starting…');

  let candidates;
  try {
    candidates = await findCandidates();
  } catch (e) {
    console.error('penyebab_analyze: failed to find candidates:', e.message);
    process.exit(1);
  }

  console.log(`penyebab_analyze: ${candidates.length} candidates to process`);
  if (!candidates.length) {
    console.log('penyebab_analyze: nothing to do.');
    return;
  }

  let done = 0, failed = 0;

  for (const batch of chunk(candidates, CONCURRENCY)) {
    await Promise.all(batch.map(async (c) => {
      try {
        await analyzeLead(c.lotus_id);
        done++;
      } catch (e) {
        failed++;
        console.error(`penyebab_analyze: fail ${c.lotus_id}: ${e.message}`);
      }
    }));
    process.stdout.write(`\rprogress: done=${done} failed=${failed} / ${candidates.length}`);
    if (done + failed < candidates.length) await sleep(SLEEP_MS);
  }

  const dur = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\npenyebab_analyze: finished in ${dur}s. done=${done} failed=${failed}`);
}

module.exports = { run, findCandidates };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => {
    console.error('FATAL', e);
    process.exit(1);
  });
}
