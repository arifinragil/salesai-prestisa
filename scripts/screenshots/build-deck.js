// Build PowerPoint marketing deck for Tiara CRM.
// Output: frontend/public/docs/Tiara-CRM-Deck.pptx
const PptxGenJS = require('pptxgenjs');
const path = require('path');
const fs = require('fs');

const OUT = path.resolve(__dirname, '../../frontend/public/docs/Tiara-CRM-Deck.pptx');
const SS = path.resolve(__dirname, '../../docs/assets/screenshots');

const C = {
  brand: '10B981',     // emerald
  brandDark: '047857',
  text: '0F172A',
  muted: '64748B',
  bg: 'F8FAFC',
  accent: 'F59E0B',
  rose: 'E11D48',
  blue: '3B82F6',
  white: 'FFFFFF',
};

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE'; // 13.33 × 7.5 inches (16:9)
pptx.author = 'Tiara CRM';
pptx.company = 'Prestisa';
pptx.title = 'Tiara CRM — WhatsApp Sales AI';
pptx.subject = 'Product & Features Overview';

// Define a master template
pptx.defineSlideMaster({
  title: 'MAIN',
  background: { color: C.white },
  objects: [
    { rect: { x: 0, y: 7.1, w: 13.33, h: 0.4, fill: { color: C.brand } } },
    { text: {
      text: 'Tiara CRM · WhatsApp Sales AI',
      options: { x: 0.5, y: 7.15, w: 6, h: 0.3, fontSize: 9, color: C.white, fontFace: 'Calibri' },
    }},
    { text: {
      text: 'salesai.prestisa.net',
      options: { x: 7.5, y: 7.15, w: 5.3, h: 0.3, fontSize: 9, color: C.white, fontFace: 'Calibri', align: 'right' },
    }},
  ],
});

// Helper: add title bar at top
function title(slide, text, sub) {
  slide.addText(text, { x: 0.5, y: 0.3, w: 12.3, h: 0.7, fontSize: 32, bold: true, color: C.text, fontFace: 'Calibri' });
  if (sub) slide.addText(sub, { x: 0.5, y: 1.0, w: 12.3, h: 0.4, fontSize: 16, color: C.muted, fontFace: 'Calibri' });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide 1: Cover
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  s.background = { color: C.text };
  s.addText('Tiara CRM', {
    x: 0.5, y: 2.2, w: 12.3, h: 1.2, fontSize: 72, bold: true, color: C.brand, fontFace: 'Calibri',
  });
  s.addText('WhatsApp Sales AI untuk Toko Bunga', {
    x: 0.5, y: 3.5, w: 12.3, h: 0.8, fontSize: 32, color: C.white, fontFace: 'Calibri',
  });
  s.addText('AI agent 24/7 + sales pipeline visibility + operator productivity toolkit.\nBangun di atas WhatsApp existing, hosted di server kamu sendiri.', {
    x: 0.5, y: 4.4, w: 12.3, h: 1.2, fontSize: 18, color: 'CBD5E1', fontFace: 'Calibri',
  });
  s.addText('Versi 1.1 · Mei 2026', {
    x: 0.5, y: 6.4, w: 12.3, h: 0.4, fontSize: 14, color: C.muted, fontFace: 'Calibri', italic: true,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide 2: Masalah
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, 'Masalah Toko Bunga Online', 'Volume chat tinggi, tim terbatas, conversion lambat');

  const problems = [
    ['⏱', 'Slow response = lost sales', 'Operator nggak sempat balas semua chat → 30-50% inquiry hilang'],
    ['🔁', 'Capek jawab pertanyaan repetitif', '60% waktu operator habis untuk FAQ harga/ongkir/jam buka'],
    ['📊', 'Tidak tahu deal stuck di mana', 'Bottleneck conversion tak ke-detect — apakah AI sering kirim form tapi customer jarang submit?'],
    ['🔥', 'Komplain telat di-handle', 'Customer kasih review buruk publik → reputation damage'],
    ['📋', 'Info customer tersebar', 'Tidak ada single source of truth → operasional rapuh'],
    ['📈', 'Mau scale, takut hire 5 operator baru', 'Margin tergerus, operasional kompleks'],
  ];

  problems.forEach((p, i) => {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const x = 0.5 + col * 6.4;
    const y = 1.7 + row * 1.7;
    s.addShape(pptx.ShapeType.roundRect, {
      x, y, w: 6, h: 1.5, fill: { color: 'FEF2F2' }, line: { color: 'FECACA', width: 1 },
      rectRadius: 0.1,
    });
    s.addText(p[0], { x: x + 0.2, y: y + 0.1, w: 0.7, h: 0.6, fontSize: 30 });
    s.addText(p[1], { x: x + 0.9, y: y + 0.15, w: 5.0, h: 0.4, fontSize: 14, bold: true, color: C.rose, fontFace: 'Calibri' });
    s.addText(p[2], { x: x + 0.9, y: y + 0.6, w: 5.0, h: 0.85, fontSize: 11, color: C.muted, fontFace: 'Calibri' });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide 3: Solusi singkat
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, 'Solusi: Tiara CRM', 'AI-first WhatsApp sales platform untuk florist');

  const cols = [
    { label: 'Untuk Customer', icon: '👥', items: [
      'Balas WA <30 detik 24/7 oleh AI "Tiara"',
      'Info harga/stok/ongkir akurat (KB-grounded)',
      'Order form prefilled — tinggal submit',
      'Reminder bayar otomatis 2 jam',
      'Konfirmasi paid + H-1 + H+1 CSAT',
    ]},
    { label: 'Untuk Operator', icon: '👨‍💼', items: [
      'Inbox terpadu + AI suggest + perhalus',
      'Quick template + snippet pribadi',
      'Customer 360 lengkap (orders, recipients, kategori)',
      'Tasks + @mention kolaborasi',
      'Bulk action (assign/snooze/stage/close)',
    ]},
    { label: 'Untuk Owner', icon: '📊', items: [
      'Sales pipeline kanban + forecast revenue',
      'Heatmap respon time + cohort retention',
      'Operator performance leaderboard',
      'AI quality scoring weekly',
      'Daily brief Telegram pukul 09:00',
    ]},
  ];

  cols.forEach((col, i) => {
    const x = 0.5 + i * 4.3;
    s.addShape(pptx.ShapeType.roundRect, {
      x, y: 1.7, w: 4.0, h: 5.2, fill: { color: 'F0FDF4' }, line: { color: 'BBF7D0', width: 1 },
      rectRadius: 0.1,
    });
    s.addText(col.icon, { x: x + 0.3, y: 1.85, w: 0.8, h: 0.6, fontSize: 28 });
    s.addText(col.label, { x: x + 1.0, y: 1.95, w: 2.8, h: 0.5, fontSize: 18, bold: true, color: C.brandDark, fontFace: 'Calibri' });
    col.items.forEach((item, j) => {
      s.addText(`✓ ${item}`, {
        x: x + 0.3, y: 2.6 + j * 0.55, w: 3.5, h: 0.5,
        fontSize: 11, color: C.text, fontFace: 'Calibri', valign: 'top',
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide 4: AI vs Hire — Comparison Table
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, 'Tiara AI vs Hire 5 Operator Manual', 'Cost & quality comparison');

  const rows = [
    ['Aspek', '5 Operator Manual', 'Tiara CRM (1-2 op + AI)'],
    ['Cost bulanan', 'Rp 25-40jt', 'Rp 8-12jt + LLM ~Rp 2jt'],
    ['Response time', '2-15 menit (peak 1+ jam)', '<30 detik konsisten'],
    ['Available 24/7', 'Tidak (shift)', 'Ya — AI tidak tidur'],
    ['Konsistensi tone', 'Variatif per operator', 'Persona terkontrol'],
    ['Track follow-up', 'Sticky note / WA pribadi', 'Auto-reminder + pipeline'],
    ['Risk halusinasi', 'Tergantung pengalaman', 'KB-grounded + confidence threshold'],
    ['Skalabilitas', 'Linear (2× chat = 2× hire)', 'Sub-linear (AI handle 80% rutin)'],
    ['Onboarding op baru', '2-4 minggu', '2-3 hari'],
  ];

  s.addTable(rows, {
    x: 0.5, y: 1.6, w: 12.3, h: 5.2,
    fontSize: 12, fontFace: 'Calibri', valign: 'middle', align: 'left',
    border: { type: 'solid', color: 'E2E8F0', pt: 1 },
    rowH: [0.5, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 0.55],
    fill: { color: C.white },
    colW: [3.0, 4.5, 4.8],
    rowOpts: [{ fill: { color: C.brand }, color: C.white, bold: true }],
  });

  s.addText('Tiara TIDAK menggantikan operator 100% — untuk negosiasi/komplain/custom price tetap handover ke manusia.\nAI eliminasi 60-80% pertanyaan rutin supaya operator fokus ke deal high-value.', {
    x: 0.5, y: 6.95, w: 12.3, h: 0.4, fontSize: 10, color: C.muted, italic: true, fontFace: 'Calibri',
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slides 5-13: Feature highlights with screenshots
// ──────────────────────────────────────────────────────────────────────────────
const FEATURES = [
  {
    title: 'Inbox Terpadu',
    sub: 'Semua chat WhatsApp di 1 layar',
    img: '01-inbox-list.png',
    bullets: [
      'Filter by status / queue / tag / pipeline stage',
      'Last intent classification AI (order_intent, pricing, complaint…)',
      'Bulk action (assign, snooze, set stage, tag, close — sekaligus)',
      'Live update via Socket.IO (no refresh)',
      'Browser push notification + bell unread badge',
    ],
  },
  {
    title: 'Sales Pipeline Kanban',
    sub: '6 stage + Lost taxonomy, auto-transition dari event',
    img: '02-pipeline-board.png',
    bullets: [
      'Stage: Baru → Tertarik → Form Dikirim → Submitted → Paid → Delivered',
      'Auto-transition dari event (intent classifier, build_order_form_url, MySQL)',
      'Drag-drop manual override',
      'Forecast: expected revenue × probability per stage',
      '8 Lost reason: no_reply, harga, kompetitor, produk_tidak_cocok, dll',
    ],
  },
  {
    title: 'AI Monitor Dashboard',
    sub: 'Bird-eye view performa AI, operator, conversion',
    img: '03-ai-monitor.png',
    bullets: [
      'KPI today (in/AI/operator/cost)',
      '24h timeline chart + heatmap respon time',
      'Operator performance per-staff (sent, respon, CSAT, AI corrections)',
      'Cohort retention — AI vs operator handled (30/60/90d)',
      'Conversion funnel + Pipeline summary 30d',
    ],
  },
  {
    title: 'Tasks & Notifications',
    sub: 'Operator productivity suite v2',
    img: '12-tasks.png',
    bullets: [
      'Tasks per-conv atau standalone, due datetime + 4-state workflow',
      'Auto-reminder 1 jam sebelum due → in-app + Telegram personal',
      'Internal comments + @mention live autocomplete (operator-only)',
      'Bell notification dengan unread badge',
      'Telegram personal binding untuk notif HP',
    ],
  },
  {
    title: 'AI Settings',
    sub: 'Configurable persona, multi-LLM, multi-channel Telegram',
    img: '04-ai-settings.png',
    bullets: [
      'Multi-LLM provider switch live (Claude / OpenAI / Gemini)',
      'Persona editor — edit prompt + version + rollback',
      'Telegram multi-channel (SLA / Anomaly / Brief)',
      'Cost cap — auto-handover saat budget habis',
      'Shadow mode per-conv — operator review sebelum kirim',
    ],
  },
  {
    title: 'Knowledge Base Self-Improving',
    sub: 'Auto-draft KB topic dari handover gap',
    img: '05-knowledge.png',
    bullets: [
      'KB topic dengan semantic search via embeddings',
      'Auto-captured pertanyaan customer saat handover low_confidence',
      'Operator approve → langsung jadi KB topic baru',
      'AI pakai kb_search tool untuk query natural language',
      'Edit langsung di UI tanpa redeploy',
    ],
  },
  {
    title: 'Templates & Snippets',
    sub: 'Reply lebih cepat — global + per-operator',
    img: '06-reply-templates.png',
    bullets: [
      'Templates global — shared semua operator',
      'Snippets pribadi — per-operator (signature, personal style)',
      'Akses sama: ketik /shortcut di composer → autocomplete',
      'Quick chips — top 6 template di atas composer',
      'Composer 1-tap insert',
    ],
  },
  {
    title: 'Tags + Pipeline Type Mapping',
    sub: 'Klasifikasi conversation + auto-detect deal type',
    img: '07-tags.png',
    bullets: [
      'Auto-tagging oleh AI berdasar intent classifier (✨ icon)',
      'Tag bisa map ke pipeline type (mis. "Wedding-2026" → wedding)',
      'Per-tag SLA override (VIP → 5 menit, default → 15 menit)',
      'Tone overlay otomatis di AI persona berdasar tag',
      'Bulk add/remove tag via inbox toolbar',
    ],
  },
  {
    title: 'User Management + Profil',
    sub: 'Role-based access + Telegram personal',
    img: '10-users.png',
    bullets: [
      'Role admin / operator / viewer',
      'Reset password, disable user',
      'Presence: dot hijau saat operator online (heartbeat 45s)',
      'Last login tracking',
      'Profil pribadi: opt-in Telegram chat ID untuk notif HP',
    ],
  },
];

FEATURES.forEach((f) => {
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, f.title, f.sub);

  // Screenshot left
  const imgPath = path.join(SS, f.img);
  if (fs.existsSync(imgPath)) {
    s.addImage({ path: imgPath, x: 0.5, y: 1.7, w: 7.5, h: 4.7, sizing: { type: 'contain', w: 7.5, h: 4.7 } });
    s.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.7, w: 7.5, h: 4.7, fill: { type: 'none' }, line: { color: 'E2E8F0', width: 1 } });
  }

  // Bullets right
  const bulletsTxt = f.bullets.map((b) => ({ text: b, options: { bullet: { code: '25CF' }, color: C.text } }));
  s.addText(bulletsTxt, {
    x: 8.3, y: 1.7, w: 4.5, h: 5.0, fontSize: 12, fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 6,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Slide: ROI Estimasi
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, 'ROI Estimasi', 'Toko bunga 5,700 chat/hari · 350 unique customer/hari · AOV Rp 500k');

  // Baseline vs Tiara comparison cards
  s.addShape(pptx.ShapeType.roundRect, {
    x: 0.5, y: 1.7, w: 6.0, h: 4.5, fill: { color: 'FEF2F2' }, line: { color: 'FECACA', width: 1 }, rectRadius: 0.1,
  });
  s.addText('🏪 Baseline (manual)', { x: 0.7, y: 1.85, w: 5.6, h: 0.5, fontSize: 18, bold: true, color: C.rose, fontFace: 'Calibri' });
  const baseline = [
    '• 5 operator × Rp 5jt = Rp 25jt/bulan',
    '• Conversion rate ~10% (35 order/hari)',
    '• 1,050 order/bulan × Rp 500k = Rp 525jt revenue',
    '• Slow response peak hour (>15 menit)',
    '• Tidak ada visibility funnel',
  ];
  baseline.forEach((b, i) => {
    s.addText(b, { x: 0.7, y: 2.5 + i * 0.65, w: 5.6, h: 0.55, fontSize: 13, color: C.text, fontFace: 'Calibri' });
  });

  s.addShape(pptx.ShapeType.roundRect, {
    x: 6.85, y: 1.7, w: 6.0, h: 4.5, fill: { color: 'F0FDF4' }, line: { color: 'BBF7D0', width: 1 }, rectRadius: 0.1,
  });
  s.addText('🚀 Setelah Tiara', { x: 7.05, y: 1.85, w: 5.6, h: 0.5, fontSize: 18, bold: true, color: C.brandDark, fontFace: 'Calibri' });
  const after = [
    '• 2 operator + AI = Rp 14jt/bulan total',
    '• Conversion rate 13-15% (~150 order extra)',
    '• Revenue ~Rp 600jt + LTV naik',
    '• Response <30 detik konsisten 24/7',
    '• Pipeline visibility lengkap + auto follow-up',
  ];
  after.forEach((b, i) => {
    s.addText(b, { x: 7.05, y: 2.5 + i * 0.65, w: 5.6, h: 0.55, fontSize: 13, color: C.text, fontFace: 'Calibri' });
  });

  // Footer summary
  s.addShape(pptx.ShapeType.roundRect, {
    x: 0.5, y: 6.4, w: 12.3, h: 0.6, fill: { color: C.brand }, line: { color: C.brand, width: 0 }, rectRadius: 0.1,
  });
  s.addText('💰 Net uplift bulan pertama: Rp 11jt saving + Rp 75jt revenue tambahan = ~Rp 86jt/bulan · ROI break-even <30 hari', {
    x: 0.5, y: 6.4, w: 12.3, h: 0.6, fontSize: 14, bold: true, color: C.white, fontFace: 'Calibri', align: 'center', valign: 'middle',
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide: Reliability & Stack
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, 'Reliability & Stack', 'Tahan banting + privacy-first');

  const cols = [
    { label: 'Anti-ban WhatsApp', items: [
      'Typing indicator natural',
      'Random reply delay 2-9s',
      'Hourly + daily send-rate caps',
      'Warmup mode untuk nomor baru',
      'Quiet hours (Asia/Jakarta)',
      'Spam contact filter',
    ]},
    { label: 'Privacy & Compliance', items: [
      'Self-hosted di server kamu',
      'PII scrubbing built-in',
      'Operator audit trail',
      'Tidak ada cloud SaaS pihak ke-3',
      'Backup harian 02:30 WIB (14 hari)',
      'LLM provider opt-out training',
    ]},
    { label: 'Tech Stack', items: [
      'Node 20 + Express 5 + PostgreSQL',
      'Next.js 14 + Tailwind + SWR',
      'Claude Sonnet + Gemini Flash + OpenAI',
      'Self-hosted WAHA (siap migrasi Meta API)',
      'Caddy auto-HTTPS + PM2',
      'Socket.IO realtime',
    ]},
  ];

  cols.forEach((col, i) => {
    const x = 0.5 + i * 4.3;
    s.addShape(pptx.ShapeType.roundRect, {
      x, y: 1.7, w: 4.0, h: 5.2, fill: { color: C.bg }, line: { color: 'E2E8F0', width: 1 }, rectRadius: 0.1,
    });
    s.addText(col.label, { x: x + 0.3, y: 1.85, w: 3.6, h: 0.5, fontSize: 16, bold: true, color: C.brandDark, fontFace: 'Calibri' });
    col.items.forEach((item, j) => {
      s.addText(`• ${item}`, {
        x: x + 0.3, y: 2.45 + j * 0.65, w: 3.5, h: 0.6, fontSize: 11, color: C.text, fontFace: 'Calibri',
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide: Roadmap
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  title(s, 'Roadmap', 'Sudah live · In design · Long-term');

  const phases = [
    { label: '✅ Live (v1 + v2)', color: 'F0FDF4', textColor: C.brandDark, items: [
      'Inbox + chat detail (AI suggest, perhalus, katalog)',
      'Sales pipeline kanban + forecast',
      'AI monitor lengkap (operator perf, cohort, funnel)',
      'KB self-improving + RAG embeddings',
      'Multi-LLM + multi-channel Telegram',
      'Customer health + facts extracted',
      'Delivery comms (paid/H-1/H+1 CSAT)',
      'Tasks + notifications + @mention (v2)',
      'Telegram personal binding (v2)',
    ]},
    { label: '⏳ Sub-project 3 (in design)', color: 'FEF3C7', textColor: '92400E', items: [
      'Customer segmentation builder',
      'Lifecycle workflow engine (trigger → actions)',
      'Pre-built journey templates:',
      '   - Birthday / anniversary',
      '   - Win-back churned customer',
      '   - Post-purchase nurture',
      '   - Abandoned cart enhanced',
    ]},
    { label: '🔮 Long-term', color: 'EFF6FF', textColor: '1E40AF', items: [
      'Loyalty points + voucher system',
      'Recurring subscription delivery',
      'Meta Cloud API migration path',
      'Voice agent integration',
      'Cross-sell ke marketplace',
    ]},
  ];

  phases.forEach((p, i) => {
    const x = 0.5 + i * 4.3;
    s.addShape(pptx.ShapeType.roundRect, {
      x, y: 1.7, w: 4.0, h: 5.2, fill: { color: p.color }, line: { color: 'E2E8F0', width: 1 }, rectRadius: 0.1,
    });
    s.addText(p.label, { x: x + 0.3, y: 1.85, w: 3.6, h: 0.5, fontSize: 14, bold: true, color: p.textColor, fontFace: 'Calibri' });
    p.items.forEach((item, j) => {
      s.addText(item, {
        x: x + 0.3, y: 2.45 + j * 0.45, w: 3.5, h: 0.4, fontSize: 10, color: C.text, fontFace: 'Calibri',
      });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide: Contact / Demo
// ──────────────────────────────────────────────────────────────────────────────
{
  const s = pptx.addSlide({ masterName: 'MAIN' });
  s.background = { color: C.text };

  s.addText('Demo + Tanya Jawab', {
    x: 0.5, y: 2.0, w: 12.3, h: 1.0, fontSize: 48, bold: true, color: C.brand, fontFace: 'Calibri',
  });
  s.addText('Lihat live, atur demo akun, atau diskusi customization', {
    x: 0.5, y: 3.1, w: 12.3, h: 0.7, fontSize: 22, color: C.white, fontFace: 'Calibri',
  });

  s.addText('🌐  salesai.prestisa.net', { x: 0.5, y: 4.5, w: 12.3, h: 0.5, fontSize: 20, color: C.white, fontFace: 'Calibri' });
  s.addText('📧  finance.parselia@gmail.com', { x: 0.5, y: 5.1, w: 12.3, h: 0.5, fontSize: 20, color: C.white, fontFace: 'Calibri' });
  s.addText('📘  Manual: salesai.prestisa.net/docs/Tiara-CRM-Manual.pdf', { x: 0.5, y: 5.7, w: 12.3, h: 0.5, fontSize: 16, color: 'CBD5E1', fontFace: 'Calibri' });
  s.addText('📊  Marketing PDF: salesai.prestisa.net/docs/Tiara-CRM-Marketing.pdf', { x: 0.5, y: 6.1, w: 12.3, h: 0.5, fontSize: 16, color: 'CBD5E1', fontFace: 'Calibri' });

  s.addText('Tiara CRM dibangun untuk Prestisa, dapat di-customize untuk toko bunga / florist lain dengan workflow serupa.', {
    x: 0.5, y: 6.7, w: 12.3, h: 0.4, fontSize: 12, color: C.muted, italic: true, fontFace: 'Calibri',
  });
}

// Write file
pptx.writeFile({ fileName: OUT })
  .then((file) => {
    const stats = fs.statSync(file);
    console.log(`[done] ${file} (${(stats.size / 1024).toFixed(0)} KB)`);
  })
  .catch((err) => { console.error(err); process.exit(1); });
