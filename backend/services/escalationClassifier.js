// #12 Escalation reason classifier — post-classify handover into actionable bucket.
// Buckets:
//   ai_bug         — AI gave wrong/contradicting answer
//   data_missing   — KB / DB lacked the info AI needed
//   out_of_scope   — request beyond agent's authority (custom price, partnership, legal)
//   customer_request — customer explicitly asked for human
const aiClient = require('./aiClient');
const logger = require('./logger');

const VALID = new Set(['ai_bug', 'data_missing', 'out_of_scope', 'customer_request']);

async function classify(client, { convId }) {
  try {
    const { rows } = await client.query(
      `SELECT direction, sender_type, body FROM crm_messages
       WHERE conversation_id = $1 AND char_length(COALESCE(body,'')) > 0
       ORDER BY id DESC LIMIT 12`,
      [convId]
    );
    if (rows.length < 2) return null;
    const transcript = rows.reverse().map((m) =>
      `${m.direction === 'in' ? 'Customer' : (m.sender_type === 'ai' ? 'AI' : 'Op')}: ${(m.body || '').slice(0, 240)}`
    ).join('\n');

    const prompt = `Analisa transkrip handover berikut. Pilih SATU label yang paling tepat menjelaskan kenapa AI tidak bisa lanjut sendiri:
- ai_bug = AI memberi jawaban salah / kontradiktif / kebingungan
- data_missing = info yang diminta customer tidak ada di KB/DB
- out_of_scope = customer minta sesuatu di luar kewenangan AI (harga custom, partnership, legal, refund kompleks)
- customer_request = customer eksplisit minta bicara dengan manusia

Output JSON valid: {"class": "label_pilihan", "reasoning": "1 kalimat singkat"}.

=== TRANSKRIP ===
${transcript}
=== END ===`;

    const r = await aiClient.generateWithTools({
      systemPrompt: 'Kamu reviewer netral. Output JSON valid saja.',
      messages: [{ role: 'user', content: prompt }],
      tools: [], executor: async () => ({}), maxIterations: 1,
    });
    const m = (r.text || '').match(/\{[\s\S]+\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!VALID.has(parsed.class)) return null;
    logger.info({ convId, class: parsed.class, reasoning: parsed.reasoning }, '[escalation-class] classified');
    return parsed.class;
  } catch (err) {
    logger.warn({ err: err.message, convId }, '[escalation-class] failed');
    return null;
  }
}

module.exports = { classify };
