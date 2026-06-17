export const LABEL = {
  lead_status: {
    closed_lost: 'Closed Lost', dormant: 'Dormant / No Response',
    pending_decision: 'Pending Decision', nurture: 'Nurture', disqualified: 'Disqualified',
  },
  funnel_stage_lost: {
    inquiry: 'Inquiry', discovery: 'Discovery', product_rec: 'Product Recommendation',
    quotation: 'Quotation', objection: 'Objection / Negotiation',
    approval: 'Approval', payment: 'Payment', no_response: 'No Response',
  },
  customer_intent: { hot: '🔥 Hot', warm: '☀️ Warm', cold: '❄️ Cold', invalid: '🚫 Invalid' },
  no_response_after: {
    greeting: 'after greeting', discovery_q: 'after discovery question',
    catalog: 'after catalog', quotation: 'after quotation', objection: 'after objection',
    approval: 'after approval', payment_instruction: 'after payment instruction',
  },
  controllability: {
    controllable: '🟢 Controllable', partially_controllable: '🟡 Partially Controllable',
    uncontrollable: '🔴 Uncontrollable',
  },
  decision_maker: {
    owner: 'Owner', purchasing: 'Purchasing', admin: 'Admin', marketing: 'Marketing',
    hr: 'HR', sekretaris: 'Sekretaris', pasangan: 'Pasangan', keluarga: 'Keluarga', unclear: 'Tidak jelas',
  },
  confidence: { high: '🟢 High', medium: '🟡 Medium', low: '🔴 Low' },
  customer_reason: {
    harga_terlalu_mahal: 'Harga Terlalu Mahal', barang_tidak_tersedia: 'Barang Tidak Tersedia',
    respon_lambat: 'Respon Lambat', info_produk_kurang: 'Info Produk Kurang',
    ekspektasi_design: 'Ekspektasi Design', area_pengiriman: 'Area Pengiriman',
    timing_pengiriman: 'Timing Pengiriman', kompetitor: 'Pilih Kompetitor',
    ragu_kredibilitas: 'Ragu Kredibilitas', window_shopping: 'Window Shopping',
    sudah_closing: 'Sudah Closing', bukan_lead: 'Bukan Lead', lainnya: 'Lainnya',
  },
};

export const INTERNAL_RC_LABEL = {
  A: 'Lead Quality', B: 'Sales Response (lambat)', C: 'Sales Discovery (gali kurang)',
  D: 'Sales Recommendation (cuma kirim katalog)', E: 'Quotation Quality',
  F: 'Price / Budget Fit', G: 'Product-Solution Fit', H: 'Objection Handling',
  I: 'Follow-up Quality', J: 'Approval Process', K: 'Trust',
  L: 'Operations / Delivery', M: 'Uncontrollable',
};

export const SALES_HANDLING_LABEL = {
  discovery: 'Discovery (gali kebutuhan)',
  recommendation: 'Recommendation (rekomendasi spesifik)',
  quotation_quality: 'Quotation Quality (penawaran lengkap)',
  objection_handling: 'Objection Handling (jawab keberatan)',
  cta: 'CTA / Next Step',
  follow_up: 'Follow-up Quality',
};

export const PRODUCT_FIT_LABEL = {
  budget: 'Budget Fit', timeline: 'Timeline Fit', occasion: 'Occasion Fit', customer_profile: 'Customer Profile Fit',
};

export const labelOf = (field, value) => LABEL[field]?.[value] || value || '—';
