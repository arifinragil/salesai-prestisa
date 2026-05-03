// Build problem → feature summary PowerPoint for Tiara CRM.
// Output: frontend/public/docs/Tiara-CRM-Problem-Feature.pptx
const PptxGenJS = require('pptxgenjs');
const path = require('path');

const OUT = path.resolve(__dirname, '../../frontend/public/docs/Tiara-CRM-Problem-Feature.pptx');

const C = {
  brand:     '10B981',
  brandDark: '047857',
  text:      '0F172A',
  muted:     '64748B',
  bg:        'F8FAFC',
  accent:    'F59E0B',
  rose:      'E11D48',
  blue:      '3B82F6',
  purple:    '8B5CF6',
  white:     'FFFFFF',
  problem:   'FEE2E2',  // light red
  problemBd: 'FCA5A5',
  feature:   'D1FAE5',  // light emerald
  featureBd: '6EE7B7',
};

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Tiara CRM';
pptx.company = 'Prestisa';
pptx.title = 'Tiara CRM — Problem → Feature Summary';
pptx.subject = 'How each feature solves a real operational problem';

pptx.defineSlideMaster({
  title: 'MAIN',
  background: { color: C.white },
  objects: [
    { rect: { x: 0, y: 7.0, w: 13.33, h: 0.5, fill: { color: C.bg } } },
    { text: {
        text: 'Tiara CRM — Prestisa',
        options: { x: 0.4, y: 7.05, w: 6, h: 0.4, fontSize: 9, color: C.muted, fontFace: 'Calibri' },
    }},
    { text: {
        text: 'Problem → Feature Summary',
        options: { x: 7.0, y: 7.05, w: 5.9, h: 0.4, fontSize: 9, color: C.muted, fontFace: 'Calibri', align: 'right' },
    }},
  ],
});

// === COVER ===
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  s.background = { color: C.brandDark };
  s.addText('Tiara CRM', { x: 0.6, y: 1.6, w: 12, h: 1.0, fontSize: 56, bold: true, color: C.white, fontFace: 'Calibri' });
  s.addText('Problem → Feature Summary', { x: 0.6, y: 2.7, w: 12, h: 0.7, fontSize: 28, color: 'A7F3D0', fontFace: 'Calibri' });
  s.addText('Setiap fitur lahir dari masalah operasional nyata — bukan feature for feature\'s sake.',
    { x: 0.6, y: 3.6, w: 12, h: 0.6, fontSize: 16, color: C.white, fontFace: 'Calibri', italic: true });
  s.addText('15 fitur, 1 platform, 1 backend — dari handle 5,700 inbound/hari sampai 1-on-1 coaching.',
    { x: 0.6, y: 5.5, w: 12, h: 0.5, fontSize: 14, color: 'A7F3D0', fontFace: 'Calibri' });
  s.addText('Mei 2026', { x: 0.6, y: 6.4, w: 12, h: 0.4, fontSize: 12, color: 'A7F3D0', fontFace: 'Calibri' });
}

// Slide layout helper: problem (red box) → feature (green box)
function pfSlide({ title, items }) {
  const s = pptx.addSlide({ masterName: 'MAIN' });
  s.addText(title, { x: 0.5, y: 0.3, w: 12.3, h: 0.6, fontSize: 26, bold: true, color: C.text, fontFace: 'Calibri' });

  const startY = 1.1;
  const rowH = (6.7 - startY) / Math.min(items.length, 4);
  items.slice(0, 4).forEach((item, i) => {
    const y = startY + i * rowH;
    // Problem box (left, 5.5"")
    s.addShape(pptx.ShapeType.roundRect, {
      x: 0.5, y, w: 5.5, h: rowH - 0.15,
      fill: { color: C.problem }, line: { color: C.problemBd, width: 1 }, rectRadius: 0.1,
    });
    s.addText('PROBLEM', { x: 0.7, y: y + 0.1, w: 2, h: 0.3, fontSize: 9, bold: true, color: 'B91C1C', fontFace: 'Calibri' });
    s.addText(item.problem, { x: 0.7, y: y + 0.4, w: 5.1, h: rowH - 0.55, fontSize: 13, color: C.text, fontFace: 'Calibri', valign: 'top' });

    // Arrow
    s.addText('→', { x: 6.05, y: y + (rowH - 0.6) / 2, w: 0.7, h: 0.5, fontSize: 28, bold: true, color: C.brandDark, fontFace: 'Calibri', align: 'center' });

    // Feature box (right, 5.5"")
    s.addShape(pptx.ShapeType.roundRect, {
      x: 6.8, y, w: 6.0, h: rowH - 0.15,
      fill: { color: C.feature }, line: { color: C.featureBd, width: 1 }, rectRadius: 0.1,
    });
    s.addText('FEATURE', { x: 7.0, y: y + 0.1, w: 2, h: 0.3, fontSize: 9, bold: true, color: '047857', fontFace: 'Calibri' });
    s.addText(item.feature, { x: 7.0, y: y + 0.4, w: 5.6, h: rowH - 0.55, fontSize: 13, color: C.text, fontFace: 'Calibri', valign: 'top' });
  });
}

// === SLIDE 1: AI core ===
pfSlide({
  title: '1. AI Reply Engine',
  items: [
    { problem: 'CS overwhelmed: ~5,700 inbound/hari, balas manual nggak skalabel — customer nunggu, kompetitor lebih cepat.',
      feature: 'AI agent "Tiara" auto-reply dengan persona santai + Indonesian-aware. Tool calling: search produk, cek order, kirim ongkir. Sub-2s response p50.' },
    { problem: 'AI generic terlalu sering ngarang harga / janji ETA spesifik / sebut produk yang nggak ada.',
      feature: 'aiGuardrails reject reply yang sebut harga di luar tool result, hesitation phrase, atau ETA spesifik. Forced retry atau handover.' },
    { problem: 'Customer tanya berulang topik yang sama tapi AI balas inkonsisten.',
      feature: 'KB topik (faq) di Postgres + Gemini embedding semantic search. Operator edit jawaban tanpa redeploy.' },
    { problem: 'Operator nggak tahu AI lagi nge-reply atau perlu intervensi.',
      feature: '/ai-monitor live dashboard: cost, latency, handover rate, model usage breakdown.' },
  ],
});

// === SLIDE 2: Co-Pilot mode ===
pfSlide({
  title: '2. Co-Pilot Mode',
  items: [
    { problem: 'Full auto AI bikin operator merasa kehilangan kontrol; sebagian customer butuh human touch.',
      feature: 'Toggle Auto ↔ Co-Pilot. Di Co-Pilot, AI generate 4 saran reply (3 dari case library + 1 AI synthesis), operator pick / edit / send.' },
    { problem: 'AI cost auto-reply per inbound mahal kalau cuma "halo" "iya" "ok".',
      feature: 'On-demand suggestion: tidak auto-generate. Tombol "✨ Generate" di chat detail — operator klik kalau perlu.' },
    { problem: 'Operator yang baru handle topik tertentu nggak tahu standard reply.',
      feature: 'Case library (crm_reply_templates) jadi sumber 3 dari 4 saran. Pattern matching by intent + regex; admin tambah case via /knowledge.' },
    { problem: 'Tidak ada feedback loop — manager nggak tahu apakah saran AI berguna atau nggak.',
      feature: 'crm_suggestion_log track usage_type (raw/edited/manual), edit_distance, pick_latency. Phase 3 dashboard pakai data ini untuk score operator.' },
  ],
});

// === SLIDE 3: Lead distribution ===
pfSlide({
  title: '3. Lead Distribution + Authentik SSO',
  items: [
    { problem: 'Semua chat masuk ke 1 inbox shared — nobody owns, response slow, double-handle.',
      feature: 'Auto distribute on first inbound: phone in DB → retention staff (least-busy). Phone baru → acquisition. Other roles see all.' },
    { problem: 'Login per-app pakai password lokal — admin lupa, security inconsistent across 17+ internal apps.',
      feature: 'Authentik SSO via Caddy forward_auth. Login sekali, akses semua app. Group → role auto-mapping (super_admin/finance → admin; cs → operator).' },
    { problem: 'Admin susah liat siapa lagi nganggur, siapa kelebihan beban.',
      feature: '/lead-distribution page: real-time staff load (open conv per orang), today distribution counts per role, manual reassign dropdown.' },
    { problem: 'Auto distribution kadang nggak sempurna — perlu admin override beberapa case.',
      feature: 'Toggle Auto/Manual mode. Manual mode: semua chat antri di unassigned, admin distribute satu-satu.' },
  ],
});

// === SLIDE 4: Lead scoring ===
pfSlide({
  title: '4. Lead Temperature Classifier',
  items: [
    { problem: 'Operator nggak tau prioritas — high-intent customer (mau bayar) sama dengan FAQ tanya jam buka.',
      feature: '🔥 Hot / 🌤️ Warm / 🧊 Cold per chat. Rule-based dari intent classifier + keyword (transfer/budget/deadline/OK) + behavior (klik order URL, multi-turn) + recency decay.' },
    { problem: 'Hot lead bisa "dingin" cepat kalau nunggu lama — risk lose deal.',
      feature: 'hotLeadAlert cron 1-min: hot lead unanswered ≥3 min → Telegram ke operator owner; ≥5 min → eskalasi supervisor.' },
    { problem: 'Pipeline board flat — semua card kelihatan sama prioritasnya.',
      feature: 'Pipeline card border kanan: rose untuk hot, amber untuk warm. Inbox sortable by temperature. Chat header tampil score (e.g. 🔥 Hot · 82).' },
    { problem: 'Sales team nggak punya data buat tuning prioritas.',
      feature: 'leadTempDecay cron 5-min recompute semua active conv. crm_conversations.lead_score jadi feed untuk supervisor scoring.' },
  ],
});

// === SLIDE 5: Supervisor & quality ===
pfSlide({
  title: '5. Supervisor Scoring + Red Flags',
  items: [
    { problem: 'Supervisor nggak punya cara objektif assess operator performance — semua subjektif.',
      feature: 'Daily composite score 0-100 per agent: 25% conversion + 20% response time + 15% CSAT + 15% suggestion usage + penalty per red flag. 4-tier (Excellent/Solid/Needs/Coaching).' },
    { problem: 'Operator slow respond, miss followup, sebut diskon yang nggak ada — nggak ada yang nge-track.',
      feature: '12 deterministic red flag rules: slow_first_response, missed_followup, suggestion_deviation, csat_low, discount_unauthorized, pii_leak, policy_violation, dll. Critical → Telegram push; high → hourly digest.' },
    { problem: 'Coaching ad-hoc, nggak terdokumentasi — lupa siapa yang lagi 1-on-1, siapa probation.',
      feature: 'Coach tag per agent: 1-on-1 scheduled / Remediation / Probation. Tampil sebagai banner di drilldown + chip di table.' },
    { problem: 'Manager butuh konteks per insiden, bukan cuma angka aggregate.',
      feature: '/supervisor/[staffId] drilldown: 30-day score history, red flag log dengan resolve modal + note, suggestion usage timeline.' },
  ],
});

// === SLIDE 6: Retention engine ===
pfSlide({
  title: '6. Retention / Lifecycle',
  items: [
    { problem: 'Customer sudah pernah order tapi 30/60/90 hari nggak chat — terlupakan, kompetitor ambil alih.',
      feature: 'Dormant detection 3-tier (warm 30d, cold 60d, dead 90d). Auto WA blast template tier-appropriate. Reply auto-route ke retention staff.' },
    { problem: 'Birthday + anniversary momen yang sangat profitable tapi nggak ada yang inget.',
      feature: 'Moments cron: scan order_items.occasion = Anniversary/Birthday, tampil 7-14 hari sebelum, generate reminder template dengan nama receiver.' },
    { problem: 'Customer sudah lost (cancel / no-show) — biasanya hilang selamanya tanpa upaya win-back.',
      feature: 'Win-back: pipeline_stage=lost dalam 60d → generate single-use 15% promo code (valid 14d) + auto WA dengan kode embedded.' },
    { problem: 'Mass blast risiko spam / WA ban kalau kirim asal.',
      feature: '/retention review UI — semua draft paused untuk admin approve per-row atau bulk per-kind sebelum fire. Cron daily disabled by default.' },
  ],
});

// === SLIDE 7: B2B outreach ===
pfSlide({
  title: '7. B2B Sequenced Outreach',
  items: [
    { problem: 'Sales B2B reactive — nunggu prospect kontak. Funnel kosong.',
      feature: 'Cold outreach campaign: filter B2B customer di MySQL (date range, total spent), preview prospect, draft 3-step sequence (intro → reminder → break-up).' },
    { problem: 'Manual sequencing capek — gampang lupa step ke-2 ke-3, miss timing.',
      feature: 'b2bTickCron 15-min advance otomatis. Prospect status: pending → in_progress → replied/opted_out/completed. Setiap step dischedule berdasarkan delay_days.' },
    { problem: 'Cold WA risiko ban kalau customer marah / report.',
      feature: 'Setiap message footer "Balas STOP untuk berhenti". Tick check ai_paused_until → auto opt-out. Reply detected → stop sequence, route ke retention.' },
    { problem: 'Sales nggak tahu campaign mana yang work, mana yang flat.',
      feature: '/b2b-outreach detail page: total/replied/opted_out/done counts per campaign. Per-prospect table dengan status + step + timing.' },
  ],
});

// === SLIDE 8: Operations infra ===
pfSlide({
  title: '8. Operations Infrastructure',
  items: [
    { problem: 'AI cost runaway risk — kalau bug atau abuse bisa tagihan jutaan dalam sehari.',
      feature: 'Cost cap setting daily_cost_cap_usd. costGuard cron monitor; over cap → AI handover ke operator + Telegram alert.' },
    { problem: 'Sentiment buruk / repeat question / dangerous intent susah detect manual.',
      feature: 'Pre-classifier (Gemini Flash, ~500ms) klasifikasi intent + sentiment + danger flag sebelum reply. handover rules: refund/cancel/explicit_request_human.' },
    { problem: 'Knowledge gap — customer tanya hal yang AI nggak tau, jawaban inconsistent antar operator.',
      feature: 'kbDraftBuilder auto-capture pertanyaan low-confidence ke crm_kb_drafts. kbRefresh cron cluster duplicate (cosine ≥0.85) + auto-draft answer untuk freq ≥2.' },
    { problem: 'Log table tumbuh tanpa batas — backup membengkak, query lambat.',
      feature: 'prune cron daily: suggestion_log 90d, red_flags 365d, hot_lead_alerts 90d, link_events 90d. Hemat storage, jaga query speed.' },
  ],
});

// === SLIDE 9: WhatsApp + WAHA ===
pfSlide({
  title: '9. WhatsApp Integration',
  items: [
    { problem: 'Resmi WA Business API mahal + slow approval; community libraries unstable.',
      feature: 'WAHA self-hosted: container Docker, 1 nomor 1 session, REST API + webhook. Multi-session ready (Phase 2 future).' },
    { problem: 'Customer pakai @lid (privacy mode) — display "12345...@lid" cryptic dan nggak bisa di-track.',
      feature: 'isLidPhone() detect + masquerade ke "🔒 No. privasi" di UI. Operator bisa "Set No." manual untuk bind ke nomor real.' },
    { problem: 'Customer kirim foto / dokumen — original WAHA URL ekspirasi cepat, history hilang.',
      feature: 'Webhook ingest mirror media ke uploads/ lokal pakai random nonce filename. History tetap accessible meski WAHA evict cache.' },
    { problem: 'Customer cek "delivered" tapi pesan diabaikan AI (sengaja paused) — kelihatan rude.',
      feature: 'sendSeen di-fire asap setelah ingest (✓✓ blue) terlepas dari AI on/off. Customer nggak pernah lihat pesan stuck di "✓".' },
  ],
});

// === SLIDE 10: Final summary ===
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  s.background = { color: C.brand };
  s.addText('Tiara CRM = 9 areas, 1 platform, 0 vendor lock-in', { x: 0.5, y: 0.4, w: 12.3, h: 0.7, fontSize: 24, bold: true, color: C.white, fontFace: 'Calibri' });

  const stats = [
    { n: '5,700', l: 'inbound/hari ditangani' },
    { n: '350', l: 'unique customer/hari' },
    { n: '12', l: 'red flag rules' },
    { n: '11', l: 'KB topik (semantic search)' },
    { n: '9', l: 'cron jobs background' },
    { n: '0', l: 'vendor lock-in (self-host)' },
  ];
  stats.forEach((st, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.5 + col * 4.3, y = 1.4 + row * 1.5;
    s.addShape(pptx.ShapeType.roundRect, { x, y, w: 4.0, h: 1.3, fill: { color: '047857' }, line: { color: 'A7F3D0', width: 1 }, rectRadius: 0.15 });
    s.addText(st.n, { x: x + 0.2, y: y + 0.1, w: 3.6, h: 0.7, fontSize: 36, bold: true, color: C.white, fontFace: 'Calibri', align: 'left' });
    s.addText(st.l, { x: x + 0.2, y: y + 0.85, w: 3.6, h: 0.4, fontSize: 12, color: 'A7F3D0', fontFace: 'Calibri' });
  });

  s.addText('Tech stack: Node 20 · Express 5 · PostgreSQL · MySQL · Next.js 14 · Tailwind v3 · Claude/Gemini/OpenAI · WAHA · Authentik SSO',
    { x: 0.5, y: 5.0, w: 12.3, h: 0.4, fontSize: 12, color: 'A7F3D0', fontFace: 'Calibri', italic: true });
  s.addText('Setiap fitur ada di sini karena ada problem operasional yang menuntutnya — bukan karena trend AI atau hype.',
    { x: 0.5, y: 5.7, w: 12.3, h: 0.5, fontSize: 14, color: C.white, fontFace: 'Calibri', italic: true });
  s.addText('finance.parselia@gmail.com  ·  Mei 2026', { x: 0.5, y: 6.5, w: 12.3, h: 0.4, fontSize: 11, color: 'A7F3D0', fontFace: 'Calibri' });
}

pptx.writeFile({ fileName: OUT }).then((f) => {
  console.log('✓ Wrote', f);
  console.log('  Public URL: https://salesai.prestisa.net/docs/Tiara-CRM-Problem-Feature.pptx');
});
