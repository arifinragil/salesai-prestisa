// #11 Customer facts extractor — runs async after handover/close.
// Asks LLM to pull structured fields from last N turns; persist into crm_customer_facts.
const aiClient = require('./aiClient');
const logger = require('./logger');

const SCHEMA_PROMPT = `Extract these from the conversation if present (use null when not mentioned):
- receiver_name (string, nama penerima rangkaian)
- receiver_address (string, alamat lengkap atau patokan)
- delivery_date (ISO YYYY-MM-DD)
- budget (integer rupiah, mis 500000)
- preference (string ringkas, mis "warna pastel, no lily")
- occasion (one of: ulang_tahun|duka_cita|wedding|grand_opening|anniversary|maaf|terima_kasih|other)

Output WAJIB JSON valid: {"receiver_name":...,"receiver_address":...,"delivery_date":...,"budget":...,"preference":...,"occasion":...}.
Tidak boleh ada teks lain.`;

const KEYS = ['receiver_name', 'receiver_address', 'delivery_date', 'budget', 'preference', 'occasion'];

async function extract(client, { convId, customerId }) {
  try {
    const { rows } = await client.query(
      `SELECT direction, sender_type, body FROM crm_messages
       WHERE conversation_id = $1 AND char_length(COALESCE(body,'')) > 0
       ORDER BY id DESC LIMIT 30`,
      [convId]
    );
    if (rows.length < 3) return;
    const transcript = rows.reverse().map((m) =>
      `${m.direction === 'in' ? 'Customer' : (m.sender_type === 'ai' ? 'AI' : 'Op')}: ${(m.body || '').slice(0, 280)}`
    ).join('\n');

    const r = await aiClient.generateWithTools({
      systemPrompt: 'Kamu data-extractor. Output JSON valid saja.',
      messages: [{ role: 'user', content: `${SCHEMA_PROMPT}\n\n=== TRANSKRIP ===\n${transcript}\n=== END ===` }],
      tools: [], executor: async () => ({}), maxIterations: 1,
    });
    const m = (r.text || '').match(/\{[\s\S]+\}/);
    if (!m) return;
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return; }

    let saved = 0;
    for (const k of KEYS) {
      const v = parsed[k];
      if (v == null || v === '' || v === 'null') continue;
      const valStr = String(v).slice(0, 500);
      // Replace existing same-key fact (latest wins) to avoid junk piling.
      await client.query(
        `DELETE FROM crm_customer_facts WHERE conversation_id = $1 AND fact_key = $2`,
        [convId, k]
      );
      await client.query(
        `INSERT INTO crm_customer_facts (conversation_id, customer_id, fact_key, fact_value, confidence)
         VALUES ($1, $2, $3, $4, 0.7)`,
        [convId, customerId || null, k, valStr]
      );
      saved++;
    }
    if (saved) logger.info({ convId, saved }, '[facts] extracted');
  } catch (err) {
    logger.warn({ err: err.message, convId }, '[facts] extract failed');
  }
}

module.exports = { extract };
