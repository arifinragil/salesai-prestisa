// Auto-generate a 2-3 sentence brief when a conv hits handover. Pulls
// recent history + last intent + customer profile so the operator gets
// instant context without scrolling.

const pg = require('../db/postgres');
const aiClient = require('./aiClient');

async function generateBrief(conversationId, reason) {
  try {
    const { rows: messages } = await pg.query(
      `SELECT direction, sender_type, body
       FROM crm_messages WHERE conversation_id = $1
       ORDER BY id DESC LIMIT 12`,
      [conversationId]
    );
    if (!messages.length) return null;
    const transcript = messages.reverse().map((m) => {
      const who = m.direction === 'in' ? 'Customer' : (m.sender_type === 'ai' ? 'AI' : 'Operator');
      return `${who}: ${(m.body || '').slice(0, 200)}`;
    }).join('\n');

    const prompt = `Berikut transkrip percakapan WhatsApp customer Prestisa (toko bunga online). Reason handover: ${reason}.

Buatkan ringkasan 2-3 kalimat untuk operator yang akan ambil alih. Format:
1. Konteks singkat (apa yang customer mau)
2. Status terakhir (apa yang sudah dijawab AI / blocker)
3. Recommended next action

Maksimum 60 kata, langsung to-the-point, no fluff. Bahasa Indonesia.

=== TRANSKRIP ===
${transcript}
=== END ===`;

    const result = await aiClient.generateWithTools({
      systemPrompt: 'Kamu asisten internal untuk operator CS Prestisa. Output ringkas, profesional, factual.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      executor: async () => ({ unsupported: true }),
      maxIterations: 1,
    });
    return (result.text || '').trim().slice(0, 500);
  } catch (err) {
    console.error('[handoverBrief] failed:', err.message);
    return null;
  }
}

module.exports = { generateBrief };
