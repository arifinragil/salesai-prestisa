'use strict';
/**
 * penyebabAnalyze.js
 * Structured "penyebab tidak closing" deep analysis using Gemini 2.5 Flash.
 *
 * Exports:
 *   buildPenyebabPrompt({ transcript, msgCount }) → string   (pure)
 *   parseAnalysis(rawText)                         → row obj (pure)
 *   analyzeLead(lotus_id)                          → Promise<row obj>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { GoogleGenerativeAI } = require('@google/generative-ai');
const lotusPg = require('../db/lotus');
const pg = require('../db/postgres');
const { isClosingPhone } = require('./orderMatch');
const {
  ISSUE_TREE_DETAIL,
  normalizeIssueTag,
  extractJson,
} = require('./penyebabTaxonomy');

// ── System instruction (ported verbatim from ads/lib/leadAnalysis.ts) ─────────

const STRUCTURED_ANALYSIS_INSTRUCTION = `
Hasilkan analisa TERSTRUKTUR mendalam dengan 4 bagian: (A) 5 Why, (B) POV Customer, (C) POV Kinerja Sales, (D) Action To-Do. Semua field WAJIB diisi berdasarkan bukti dari percakapan (kutip contoh nyata bila ada). Bahasa Indonesia, ringkas tetapi spesifik.

A. 5 WHY (akar masalah berjenjang):
- why1: alasan langsung customer tidak jadi membeli (yang terlihat/disampaikan).
- why2: kenapa alasan itu muncul.
- why3: kelemahan pada penawaran atau cara handling Sales.
- why4: penyebab pada proses/sistem (mis. tidak ada standar quotation).
- why5: akar masalah manajerial (mis. belum ada playbook objection handling).
- root_cause: rumusan akar masalah utama (1 kalimat).
- corrective_action: tindakan korektif sistemik (1 kalimat).

B. POV CUSTOMER:
- kebutuhan_inti, sentiment (emosi customer), kepuasan_handling (boleh pakai emoji 😞/😐/🙂), urgency, pain_point, ekspektasi_tidak_terpenuhi. Jika tidak ada bukti, tulis "Tidak ditemukan".

C. POV KINERJA SALES:
- good: array poin "Hal yang sudah baik" (tiap item format "Judul — penjelasan. Contoh: <kutipan>").
- problem: array poin "Masalah yang teridentifikasi" (format sama). Ikuti LOGIKA PENILAIAN di atas — jangan asal menyalahkan kecepatan Sales.

D. ACTION TO-DO:
- status_percakapan (mis. "menunggu customer" / "menunggu Sales").
- risk_assessment (mis. "churn (high) — ...; potensi closing (low) — ...").
- next_actions: array 1-3 item, tiap item {"priority":"P1|P2|P3","action":"...","deadline":"..."}.
- coaching_note: catatan coaching untuk Sales (1-2 kalimat).
- pola_monitor: pola yang perlu dimonitor manajemen.

E. ISSUE TREE (klasifikasi resmi — WAJIB):
Tentukan SATU penyebab utama tidak closing menurut taksonomi resmi berikut. Pilih PERSIS satu "issue", satu "sub_issue", dan satu "rinci" (Keterangan Rinci) — salin teksnya APA ADANYA dari daftar. "rinci" WAJIB diambil dari daftar pada sub_issue yang kamu pilih. Lalu beri "detail" 1 kalimat bukti dari percakapan. Pilih yang PALING menjadi alasan langsung lead ini gagal closing.
${Object.entries(ISSUE_TREE_DETAIL).map(([issue, subs]) =>
  `■ ${issue}\n` + Object.entries(subs).map(([s, ds]) => `   • ${s} → ${ds.join(' | ')}`).join('\n')
).join('\n')}

Jawab HANYA JSON valid (tanpa teks lain, tanpa markdown) dengan bentuk PERSIS:
{"penyebab_tidak_closing":"<1 kalimat singkat & spesifik untuk kategorisasi>","ringkasan":"<maks 2 kalimat>","issue_tree":{"issue":"<salah satu issue resmi>","sub_issue":"<salah satu sub_issue dari issue tsb>","rinci":"<salah satu Keterangan Rinci dari sub_issue tsb>","detail":"<1 kalimat bukti>"},"five_why":{"why1":"","why2":"","why3":"","why4":"","why5":"","root_cause":"","corrective_action":""},"pov_customer":{"kebutuhan_inti":"","sentiment":"","kepuasan_handling":"","urgency":"","pain_point":"","ekspektasi_tidak_terpenuhi":""},"pov_sales":{"good":[""],"problem":[""]},"action":{"status_percakapan":"","risk_assessment":"","next_actions":[{"priority":"P1","action":"","deadline":""}],"coaching_note":"","pola_monitor":""}}`.trim();

// ── Pure: buildPenyebabPrompt ─────────────────────────────────────────────────

/**
 * Build the user prompt embedding the system instruction + transcript.
 * @param {{ transcript: string, msgCount: number }} opts
 * @returns {string}
 */
function buildPenyebabPrompt({ transcript, msgCount }) {
  return `${STRUCTURED_ANALYSIS_INSTRUCTION}

Transkrip (${msgCount} pesan):
${transcript}`;
}

// ── Pure: parseAnalysis ───────────────────────────────────────────────────────

/**
 * Parse Gemini raw response text → row shape for crm_lead_penyebab.
 * @param {string|null} rawText
 * @returns {{ is_closing, churn, issue, sub_issue, rinci, penyebab_tidak_closing, analisa }|null}
 */
function parseAnalysis(rawText) {
  if (!rawText) return null;
  const parsed = extractJson(rawText);
  if (!parsed) return null;

  const penyebab_tidak_closing = String(parsed.penyebab_tidak_closing || '').trim();
  const riskAssessment = parsed.action?.risk_assessment || '';
  const churn = /churn/i.test(riskAssessment);
  const is_closing = Boolean(parsed.is_closing);

  const tag = normalizeIssueTag(parsed.issue_tree);
  let issue = null, sub_issue = null, rinci = null;
  if (tag) {
    issue = tag.issue;
    sub_issue = tag.sub_issue;
    rinci = tag.rinci || null;
  }

  return {
    is_closing,
    churn,
    issue,
    sub_issue,
    rinci,
    penyebab_tidak_closing,
    analisa: parsed,
  };
}

// ── Async: analyzeLead ────────────────────────────────────────────────────────

const MAX_MSGS = 40;
const BODY_LIMIT = 500;

/**
 * Run penyebab analysis for a given lotus_id and upsert result into crm_lead_penyebab.
 * @param {string} lotus_id
 * @returns {Promise<object>} stored row
 */
async function analyzeLead(lotus_id) {
  // 1. Resolve contact info from lotus DB
  const contactRes = await lotusPg.query(
    `SELECT cust_number, business_number FROM contacts WHERE lotus_id = $1 LIMIT 1`,
    [lotus_id]
  );
  if (!contactRes.rows.length) throw new Error(`lotus_id not found: ${lotus_id}`);
  const { cust_number, business_number } = contactRes.rows[0];

  // is_closing is determined by the POS, not the LLM: did this phone place a
  // real (non-cancelled) order? Overrides the unreliable parsed.is_closing.
  const is_closing = await isClosingPhone(cust_number);

  // 2. Build transcript (oldest→newest, cap 40 newest, label like the cron)
  const msgRes = await lotusPg.query(
    `SELECT direction, body, received_at, cs_name, cs_id
       FROM messages
      WHERE cust_number = $1 AND business_number = $2
      ORDER BY received_at ASC NULLS LAST, id ASC
      LIMIT $3`,
    [cust_number, business_number, MAX_MSGS]
  );
  const rows = msgRes.rows;
  const transcript = rows.map(m => {
    let who;
    if (m.direction === 'inbound') {
      who = 'Customer';
    } else if (m.cs_id) {
      who = `Sales (${m.cs_name || m.cs_id})`;
    } else {
      who = 'AI Bot';
    }
    const body = (m.body || '').slice(0, BODY_LIMIT);
    return `${who}: ${body}`;
  }).join('\n');
  const msgCount = rows.length;

  // 3. Call Gemini
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: STRUCTURED_ANALYSIS_INSTRUCTION,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const prompt = buildPenyebabPrompt({ transcript, msgCount });
  let geminiRes;
  try {
    geminiRes = await model.generateContent(prompt);
  } catch (e) {
    throw new Error(`Gemini call failed: ${e.message}`);
  }
  const u = geminiRes.response.usageMetadata || {};
  const rawText = geminiRes.response.text().trim();

  // 4. Parse
  const parsed = parseAnalysis(rawText);
  if (!parsed) throw new Error(`Failed to parse Gemini response: ${rawText.slice(0, 200)}`);

  const tokensIn = u.promptTokenCount || 0;
  const tokensOut = u.candidatesTokenCount || 0;

  // 5. Upsert into crm_lead_penyebab
  const upsertRes = await pg.query(
    `INSERT INTO crm_lead_penyebab
       (lotus_id, cust_number, business_number,
        is_closing, churn, issue, sub_issue, rinci,
        penyebab_tidak_closing, analisa,
        ai_model, ai_tokens_in, ai_tokens_out, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
     ON CONFLICT (lotus_id) DO UPDATE SET
       cust_number           = EXCLUDED.cust_number,
       business_number       = EXCLUDED.business_number,
       is_closing            = EXCLUDED.is_closing,
       churn                 = EXCLUDED.churn,
       issue                 = EXCLUDED.issue,
       sub_issue             = EXCLUDED.sub_issue,
       rinci                 = EXCLUDED.rinci,
       penyebab_tidak_closing= EXCLUDED.penyebab_tidak_closing,
       analisa               = EXCLUDED.analisa,
       ai_model              = EXCLUDED.ai_model,
       ai_tokens_in          = EXCLUDED.ai_tokens_in,
       ai_tokens_out         = EXCLUDED.ai_tokens_out,
       analyzed_at           = now()
     RETURNING *`,
    [
      lotus_id, cust_number, business_number,
      is_closing, parsed.churn,
      parsed.issue, parsed.sub_issue, parsed.rinci,
      parsed.penyebab_tidak_closing,
      JSON.stringify(parsed.analisa),
      'gemini-2.5-flash', tokensIn, tokensOut,
    ]
  );

  return upsertRes.rows[0];
}

module.exports = { buildPenyebabPrompt, parseAnalysis, analyzeLead, STRUCTURED_ANALYSIS_INSTRUCTION };
