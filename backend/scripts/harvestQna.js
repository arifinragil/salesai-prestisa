// backend/scripts/harvestQna.js
// Nightly harvest of won raw-used reply suggestions into the Q&A base.
// Won = conversation reached pipeline_stage IN ('paid','delivered').
// Raw-used = suggestion was picked and sent as-is (usage_type = 'raw').
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const pg = require('../db/postgres');
const { upsertQna, embedPending } = require('../services/qnaRag');

const LIMIT = 500;

async function run() {
  const { rows } = await pg.query(`
    SELECT sl.id,
           im.body AS question,
           COALESCE(sm.body, (sl.options->>(sl.picked_rank::text))) AS answer
    FROM crm_suggestion_log sl
    JOIN crm_conversations c ON c.id = sl.conversation_id
    LEFT JOIN crm_messages im ON im.id = sl.inbound_msg_id
    LEFT JOIN crm_messages sm ON sm.id = sl.sent_msg_id
    WHERE sl.usage_type = 'raw'
      AND c.pipeline_stage IN ('paid', 'delivered')
      AND sl.inbound_msg_id IS NOT NULL
    ORDER BY sl.shown_at DESC
    LIMIT $1
  `, [LIMIT]);

  console.log(`Candidates fetched: ${rows.length}`);

  let count = 0;
  for (const row of rows) {
    const question = (row.question || '').trim();
    const answer = (row.answer || '').trim();
    if (!question || !answer) continue;
    await upsertQna({ question, answer, source: 'won' });
    count++;
  }

  const n = await embedPending(500);
  console.log('harvested', count, 'embedded', n);
}

if (require.main === module) {
  (async () => {
    try {
      await run();
    } catch (e) {
      console.error('FATAL', e.message);
      process.exit(1);
    } finally {
      await pg.end();
    }
  })();
}

module.exports = { run };
