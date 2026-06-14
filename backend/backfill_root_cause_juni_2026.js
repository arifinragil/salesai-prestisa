// backfill_root_cause_juni_2026.js — one-shot backfill of root_cause_tag
// for conversations active in Juni 2026. Uses existing ai_summary cache to
// classify, so no full re-generation is needed.
//
// Usage:
//   node backend/backfill_root_cause_juni_2026.js --dry-run --limit=5
//   node backend/backfill_root_cause_juni_2026.js --limit=100
//   node backend/backfill_root_cause_juni_2026.js --lotus-id=<id>
//   node backend/backfill_root_cause_juni_2026.js                    # full run

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pg      = require('./db/postgres');
const lotusPg = require('./db/lotus');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TAXONOMY, isValidKey } = require('./services/rootCauseTaxonomy');

const args = process.argv.slice(2);
const DRY     = args.includes('--dry-run');
const ONLY_ID = (args.find(a => a.startsWith('--lotus-id=')) || '').split('=')[1] || null;
const LIMIT   = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);

const CONCURRENCY = 4;
const SLEEP_MS    = 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function classify(summary) {
  const prompt = `Berikut ringkasan percakapan WhatsApp customer flower shop. Klasifikasikan root_cause kenapa customer tidak jadi closing/order.

Ringkasan:
"""
${String(summary).slice(0, 4000)}
"""

Pilih persis 1 key dari taxonomy berikut:
${TAXONOMY.map(t => `- ${t.key.padEnd(24)} (${t.desc})`).join('\n')}

Output 1 baris JSON saja, tanpa code fence, tanpa teks lain:
{"root_cause_tag":"<key>","confidence":0.0-1.0}`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
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

(async () => {
  const lotusIds = ONLY_ID
    ? [ONLY_ID]
    : (await lotusPg.query(
        `SELECT lotus_id FROM contacts
          WHERE last_message_at >= '2026-06-01'
            AND last_message_at <  '2026-07-01'`
      )).rows.map(r => r.lotus_id);

  console.log(`scanned lotus_ids in juni 2026: ${lotusIds.length}`);
  if (!lotusIds.length) { console.log('nothing to do'); process.exit(0); }

  const rows = (await pg.query(
    `SELECT lotus_id, ai_summary FROM crm_lotus_state
      WHERE lotus_id = ANY($1::text[])
        AND root_cause_tag IS NULL
        AND ai_summary IS NOT NULL`,
    [lotusIds]
  )).rows;

  const work = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`candidates with ai_summary & no tag: ${work.length}  dry=${DRY}`);
  if (!work.length) { console.log('all clear'); process.exit(0); }

  let done = 0, failed = 0, skipped = 0;
  const startedAt = Date.now();

  for (const batch of chunk(work, CONCURRENCY)) {
    await Promise.all(batch.map(async (r) => {
      try {
        const tag = await classify(r.ai_summary);
        if (!tag) { skipped++; return; }
        if (DRY) {
          console.log(`[dry] ${r.lotus_id} → ${tag.tag} (conf=${tag.confidence})`);
        } else {
          await pg.query(
            `UPDATE crm_lotus_state
                SET root_cause_tag = $2,
                    root_cause_confidence = $3,
                    root_cause_tagged_at = now()
              WHERE lotus_id = $1`,
            [r.lotus_id, tag.tag, tag.confidence]
          );
        }
        done++;
      } catch (e) {
        failed++;
        console.error(`fail ${r.lotus_id}: ${e.message}`);
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
