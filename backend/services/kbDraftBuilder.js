// Knowledge gap auto-draft: when AI handover with low_confidence,
// capture the unanswered question into crm_kb_drafts for operator review.
const logger = require('./logger');

async function capture(client, { convId, msgId, question, reason }) {
  try {
    if (!question || question.length < 5) return;
    // Skip if same question (per conv) already pending
    const dup = await client.query(
      `SELECT 1 FROM crm_kb_drafts
       WHERE conversation_id = $1 AND question = $2 AND status = 'pending'`,
      [convId, question]
    );
    if (dup.rows.length) return;
    await client.query(
      `INSERT INTO crm_kb_drafts (conversation_id, message_id, question, suggested_answer, status)
       VALUES ($1, $2, $3, NULL, 'pending')`,
      [convId, msgId, question.slice(0, 1000)]
    );
    logger.info({ conv_id: convId, reason, q_len: question.length }, '[kb-draft] captured');
  } catch (err) {
    logger.warn({ err: err.message, convId }, '[kb-draft] capture failed');
  }
}

module.exports = { capture };
