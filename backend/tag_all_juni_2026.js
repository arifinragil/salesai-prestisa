// tag_all_juni_2026.js — classify ALL qualified conversations (≥3 inbound)
// in Juni 2026 directly from transcript. Skips ai_summary generation.
//
// Usage:
//   node backend/tag_all_juni_2026.js --dry-run --limit=3
//   node backend/tag_all_juni_2026.js --limit=100
//   node backend/tag_all_juni_2026.js                    # full run
//
// Cost estimate: ~3k input + 50 output per call. ~3000 qualified leads.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pg      = require('./db/postgres');
const lotusPg = require('./db/lotus');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TAXONOMY, isValidKey } = require('./services/rootCauseTaxonomy');

const args = process.argv.slice(2);
const DRY   = args.includes('--dry-run');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);

const CONCURRENCY = 6;
const SLEEP_MS    = 600;
const MSG_LIMIT   = 60;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 256,
    thinkingConfig: { thinkingBudget: 0 },
  },
});

const taxonomyList = TAXONOMY.map(t => `- ${t.key.padEnd(24)} (${t.desc})`).join('\n');

async function loadTranscript(custNumber, businessNumber) {
  const rows = (await lotusPg.query(
    `SELECT direction, body, message_type, received_at, cs_name
       FROM messages
      WHERE cust_number = $1 AND business_number = $2
      ORDER BY received_at ASC NULLS LAST, id ASC
      LIMIT $3`,
    [custNumber, businessNumber, MSG_LIMIT]
  )).rows;
  return rows.map(m => {
    const who = m.direction === 'inbound' ? 'Customer'
              : (m.cs_name ? `Operator (${m.cs_name})` : 'Operator');
    const body = (m.body || `[${m.message_type}]`).toString().slice(0, 300);
    return `${who}: ${body}`;
  }).join('\n');
}

async function classify(transcript) {
  const prompt = `Analisa percakapan WhatsApp customer flower shop. Klasifikasikan root_cause utama kenapa customer tidak jadi closing (atau "lainnya" kalau ternyata sudah closing).

Transkrip:
"""
${transcript.slice(0, 8000)}
"""

Pilih 1 key dari taxonomy:
${taxonomyList}

Output 1 baris JSON saja (no code fence, no other text):
{"root_cause_tag":"<key>","confidence":0.0-1.0}`;

  const r = await model.generateContent(prompt);
  const txt = r.response.text().trim();
  const m = txt.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!isValidKey(j.root_cause_tag)) return null;
  const conf = Number(j.confidence);
  return {
    tag: j.root_cause_tag,
    confidence: (!Number.isNaN(conf) && conf >= 0 && conf <= 1) ? conf : null,
  };
}

async function ensureStateRow(client, lotusId, custNumber) {
  await client.query(
    `INSERT INTO crm_lotus_state (lotus_id, cust_number)
     VALUES ($1, $2) ON CONFLICT (lotus_id) DO NOTHING`,
    [lotusId, custNumber]
  );
}

(async () => {
  const startedAt = Date.now();
  // Qualified contacts in Juni that don't have a tag yet.
  const candidatesAll = (await lotusPg.query(`
    SELECT c.lotus_id, c.cust_number, c.business_number
    FROM contacts c
    WHERE c.last_message_at >= '2026-06-01'
      AND c.last_message_at <  '2026-07-01'
      AND (SELECT COUNT(*) FROM messages m
             WHERE m.cust_number = c.cust_number
               AND m.business_number = c.business_number
               AND m.direction = 'inbound') >= 3
    ORDER BY c.last_message_at DESC
  `)).rows;
  console.log(`qualified Juni 2026: ${candidatesAll.length}`);

  // Filter out already-tagged
  const tagged = new Set(
    (await pg.query(
      `SELECT lotus_id FROM crm_lotus_state
        WHERE lotus_id = ANY($1::text[]) AND root_cause_tag IS NOT NULL`,
      [candidatesAll.map(c => c.lotus_id)]
    )).rows.map(r => r.lotus_id)
  );
  const candidates = candidatesAll.filter(c => !tagged.has(c.lotus_id));
  console.log(`untagged: ${candidates.length}`);

  const work = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates;
  console.log(`processing: ${work.length}  dry=${DRY}\n`);

  let done = 0, failed = 0, skipped = 0;

  for (const batch of chunk(work, CONCURRENCY)) {
    await Promise.all(batch.map(async (c) => {
      try {
        const transcript = await loadTranscript(c.cust_number, c.business_number);
        if (!transcript) { skipped++; return; }
        const tag = await classify(transcript);
        if (!tag) { skipped++; return; }
        if (DRY) {
          console.log(`[dry] ${c.lotus_id} → ${tag.tag} (conf=${tag.confidence})`);
        } else {
          await ensureStateRow(pg, c.lotus_id, c.cust_number);
          await pg.query(
            `UPDATE crm_lotus_state
                SET root_cause_tag = $2,
                    root_cause_confidence = $3,
                    root_cause_tagged_at = now()
              WHERE lotus_id = $1`,
            [c.lotus_id, tag.tag, tag.confidence]
          );
        }
        done++;
      } catch (e) {
        failed++;
        console.error(`\nfail ${c.lotus_id}: ${e.message}`);
      }
    }));
    process.stdout.write(`\rprogress: done=${done} skip=${skipped} fail=${failed} / ${work.length}`);
    await sleep(SLEEP_MS);
  }
  const dur = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\nFinished in ${dur}s. done=${done} skipped=${skipped} failed=${failed}`);
  process.exit(0);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
