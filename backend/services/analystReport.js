// backend/services/analystReport.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { validateTierAOutput, SALES_HANDLING_KEYS, PRODUCT_FIT_KEYS } = require('./analystTaxonomy');

const TIER_A_SYSTEM = `Kamu adalah Sales Performance Analyst untuk Prestisa (toko bunga/parsel premium).
Tugasmu: klasifikasi lead WhatsApp yang tidak closing ke 10 dimensi struktur.
Output WAJIB JSON valid sesuai schema. Tidak boleh ada teks lain di luar JSON.
Diagnosis berbasis bukti chat. Tidak boleh mengarang. Kalau ragu, set confidence='low'.
Pisahkan jelas Customer Reason (alasan permukaan customer) vs Internal Root Cause (akar masalah yang tim bisa fix).`;

function buildTierAUserPrompt({ transcript, msgCount, inboundCount }) {
  return `Analisa transkrip berikut dan output JSON dengan field-field ini.

ENUM yang valid:
lead_status:       "closed_lost" | "dormant" | "pending_decision" | "nurture" | "disqualified"
funnel_stage_lost: "inquiry" | "discovery" | "product_rec" | "quotation" | "objection" | "approval" | "payment" | "no_response"
customer_intent:   "hot" | "warm" | "cold" | "invalid"
no_response_after: "greeting" | "discovery_q" | "catalog" | "quotation" | "objection" | "approval" | "payment_instruction" | null
controllability:   "controllable" | "partially_controllable" | "uncontrollable"
decision_maker:    "owner" | "purchasing" | "admin" | "marketing" | "hr" | "sekretaris" | "pasangan" | "keluarga" | "unclear"
confidence:        "high" | "medium" | "low"

Kategori internal_root_cause (pilih 1-3 huruf, multi-select):
A=Lead Quality, B=Sales Response (lambat), C=Sales Discovery (gali kurang),
D=Sales Recommendation (cuma kirim katalog), E=Quotation Quality (penawaran tidak lengkap),
F=Price/Budget Fit, G=Product-Solution Fit, H=Objection Handling,
I=Follow-up Quality, J=Approval Process (decision maker tidak dipetakan),
K=Trust (ragu kredibilitas), L=Operations/Delivery (jadwal/area/stok),
M=Uncontrollable (acara batal / customer di luar kendali).

Kategori customer_reason (Customer Reason — pilih 1):
harga_terlalu_mahal | barang_tidak_tersedia | respon_lambat | info_produk_kurang |
ekspektasi_design | area_pengiriman | timing_pengiriman | kompetitor |
ragu_kredibilitas | window_shopping | sudah_closing | bukan_lead | lainnya

sales_handling — 6 boolean (true = sudah baik, false = ada gap):
discovery, recommendation, quotation_quality, objection_handling, cta, follow_up

product_solution_fit — 4 boolean nullable (null kalau tidak relevan):
budget, timeline, occasion, customer_profile

Output JSON saja, tidak ada teks lain:
{
  "customer_reason": "...",
  "lead_status": "...",
  "funnel_stage_lost": "...",
  "customer_intent": "...",
  "no_response_after": "..." | null,
  "controllability": "...",
  "decision_maker": "...",
  "internal_root_cause_categories": ["F","H"],
  "sales_handling": {"discovery": false, "recommendation": false, "quotation_quality": true, "objection_handling": false, "cta": true, "follow_up": false},
  "product_solution_fit": {"budget": false, "timeline": true, "occasion": true, "customer_profile": null},
  "confidence": "high",
  "evidence_quote": "<quote max 100 char>"
}

Transkrip (${msgCount} pesan, ${inboundCount} inbound):
${transcript}`;
}

async function runTierA({ transcript, msgCount, inboundCount, geminiKey }) {
  const genAI = new GoogleGenerativeAI(geminiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: TIER_A_SYSTEM,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 800,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const prompt = buildTierAUserPrompt({ transcript, msgCount, inboundCount });
  const t0 = Date.now();
  let r;
  try { r = await model.generateContent(prompt); }
  catch (e) { throw new Error(`gemini call failed: ${e.message}`); }
  const u = r.response.usageMetadata || {};
  const txt = r.response.text().trim();
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (e) { throw new Error(`gemini returned non-JSON: ${txt.slice(0, 200)}`); }
  const validated = validateTierAOutput(parsed);
  return {
    validated,
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 },
    duration_ms: Date.now() - t0,
  };
}

module.exports = { runTierA, buildTierAUserPrompt, TIER_A_SYSTEM };
