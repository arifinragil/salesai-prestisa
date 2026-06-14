// Re-classify conversations currently tagged "lainnya" — taxonomy was extended
// with `sudah_closing` and `bukan_lead`, so many of these likely fit there.
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
  const prompt = `Analisa percakapan WhatsApp customer flower shop. Klasifikasikan root_cause.

Kategori "sudah_closing" pakai kalau ada jejak order (operator kirim "Foto hasil untuk PO XXXX", customer konfirmasi terima, PO number muncul, atau ada konfirmasi pembayaran).
Kategori "bukan_lead" pakai kalau pesan customer bukan minat beli (salah kirim, pitch sales lain, komplain saja, dst).
Kategori "lainnya" HANYA kalau benar-benar tidak ada kategori spesifik yang cocok.

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

(async () => {
  const startedAt = Date.now();
  const lainnyaIds = (await pg.query(
    `SELECT lotus_id FROM crm_lotus_state WHERE root_cause_tag='lainnya'`
  )).rows.map(r => r.lotus_id);
  console.log(`lainnya total: ${lainnyaIds.length}`);

  // Get cust_number/business_number for each
  const contacts = (await lotusPg.query(
    `SELECT lotus_id, cust_number, business_number FROM contacts WHERE lotus_id = ANY($1::text[])`,
    [lainnyaIds]
  )).rows;
  console.log(`contacts resolved: ${contacts.length}`);

  const work = LIMIT > 0 ? contacts.slice(0, LIMIT) : contacts;
  console.log(`processing: ${work.length}  dry=${DRY}\n`);

  let done = 0, failed = 0, skipped = 0, changed = 0;
  const changedCounts = {};

  for (const batch of chunk(work, CONCURRENCY)) {
    await Promise.all(batch.map(async (c) => {
      try {
        const transcript = await loadTranscript(c.cust_number, c.business_number);
        if (!transcript) { skipped++; return; }
        const tag = await classify(transcript);
        if (!tag) { skipped++; return; }
        if (tag.tag !== 'lainnya') {
          changed++;
          changedCounts[tag.tag] = (changedCounts[tag.tag] || 0) + 1;
        }
        if (DRY) {
          if (tag.tag !== 'lainnya') console.log(`[dry] ${c.lotus_id} lainnya → ${tag.tag}`);
        } else {
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
    process.stdout.write(`\rprogress: done=${done} changed=${changed} skip=${skipped} fail=${failed} / ${work.length}`);
    await sleep(SLEEP_MS);
  }
  const dur = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log(`\n\nFinished in ${dur}s.`);
  console.log(`Total processed: ${done}`);
  console.log(`Changed away from lainnya: ${changed} (${(changed/done*100).toFixed(1)}%)`);
  console.log(`Distribution of reclassified:`, changedCounts);
  process.exit(0);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
