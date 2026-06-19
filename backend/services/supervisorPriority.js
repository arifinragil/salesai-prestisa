// backend/services/supervisorPriority.js
// Logika murni Supervisor Control Panel: tentukan priority (P1/P2/P3), groups, dan
// bucket Lead Stuck (A/B/C/D) dari sinyal + field analyst. Tanpa DB.

const STUCK_MAP = {
  harga_terlalu_mahal:   { bucket: 'A', label: 'Keberatan harga' },
  window_shopping:       { bucket: 'A', label: 'Masih tanya-tanya / window shopping' },
  kompetitor:            { bucket: 'A', label: 'Bandingkan vendor' },
  ragu_kredibilitas:     { bucket: 'A', label: 'Ragu kredibilitas' },
  respon_lambat:         { bucket: 'B', label: 'Respon lambat (sales)' },
  info_produk_kurang:    { bucket: 'B', label: 'Kurang gali kebutuhan / info produk' },
  barang_tidak_tersedia: { bucket: 'C', label: 'Stok kosong' },
  ekspektasi_design:     { bucket: 'C', label: 'Desain kurang cocok' },
  area_pengiriman:       { bucket: 'C', label: 'Kendala area pengiriman' },
  timing_pengiriman:     { bucket: 'C', label: 'Kendala waktu pengiriman' },
  bukan_lead:            { bucket: 'D', label: 'Bukan lead / proses' },
  lainnya:               { bucket: 'D', label: 'Lainnya (proses)' },
};

const INQUIRY_RE = /tanya|harga|price|info|nanya|inquiry/i;
const HIGH_SCORE = 60;

function num(v) { const n = Number(v); return (v == null || Number.isNaN(n)) ? null : n; }

function classify(lead) {
  const status = lead.status || 'active';
  if (status !== 'active') return { priority: null, groups: [], stuck_bucket: null, stuck_label: null };

  const asr = num(lead.awaiting_sales_reply_min);
  const acr = num(lead.awaiting_customer_reply_min);
  const lag = num(lead.first_response_lag_min);
  const score = num(lead.lead_score);
  const hot = /hot/i.test(String(lead.lead_temperature || ''));
  const asked = !!lead.asked_price;
  const inquiry = INQUIRY_RE.test(String(lead.last_intent || '')) || INQUIRY_RE.test(String(lead.customer_intent || ''));
  const fuIncomplete = lead.fu_status === 'overdue';
  const stuck = !!(lead.root_cause_tag || lead.funnel_stage_lost) && lead.root_cause_tag !== 'sudah_closing';
  // Customer-silence hanya actionable dalam jendela 1 jam–24 jam (>24 jam = stale / data-pending).
  const acrActionable = acr != null && acr > 60 && acr <= 1440;

  const groups = [];
  if (lead.never_responded || asr != null || (lag != null && lag > 1)) groups.push('sales_response_risk');
  if (acrActionable || lead.fu_status === 'overdue' || lead.single_bubble) groups.push('follow_up');
  if (stuck) groups.push('lead_stuck');

  const p1 = lead.never_responded || (asr != null && asr >= 2) || (asked && asr != null);
  const p2 = acrActionable || fuIncomplete || ((hot || (score != null && score >= HIGH_SCORE)) && stuck);
  const p3 = lead.single_bubble || inquiry || groups.length > 0;

  let priority = null;
  if (!groups.length && !p1) priority = null;
  else if (p1) priority = 'P1';
  else if (p2) priority = 'P2';
  else if (p3) priority = 'P3';

  let stuck_bucket = null, stuck_label = null;
  if (stuck) {
    const m = STUCK_MAP[lead.root_cause_tag];
    if (m) { stuck_bucket = m.bucket; stuck_label = m.label; }
    else { stuck_bucket = 'D'; stuck_label = lead.funnel_stage_lost ? `Proses: ${lead.funnel_stage_lost}` : 'Proses'; }
  }

  return { priority, groups, stuck_bucket, stuck_label };
}

module.exports = { classify, STUCK_MAP };
