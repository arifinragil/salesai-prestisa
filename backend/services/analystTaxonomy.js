// backend/services/analystTaxonomy.js
// Enum + validator untuk Tier A structured fields.

const ENUMS = {
  lead_status:       ['closed_lost','dormant','pending_decision','nurture','disqualified'],
  funnel_stage_lost: ['inquiry','discovery','product_rec','quotation','objection','approval','payment','no_response'],
  customer_intent:   ['hot','warm','cold','invalid'],
  no_response_after: ['greeting','discovery_q','catalog','quotation','objection','approval','payment_instruction'],
  controllability:   ['controllable','partially_controllable','uncontrollable'],
  decision_maker:    ['owner','purchasing','admin','marketing','hr','sekretaris','pasangan','keluarga','unclear'],
  confidence:        ['high','medium','low'],
  customer_reason:   [
    'harga_terlalu_mahal','barang_tidak_tersedia','respon_lambat','info_produk_kurang',
    'ekspektasi_design','area_pengiriman','timing_pengiriman','kompetitor',
    'ragu_kredibilitas','window_shopping','sudah_closing','bukan_lead','lainnya',
  ],
};

const INTERNAL_RC_VALID = ['A','B','C','D','E','F','G','H','I','J','K','L','M'];

const SALES_HANDLING_KEYS = ['discovery','recommendation','quotation_quality','objection_handling','cta','follow_up'];
const PRODUCT_FIT_KEYS    = ['budget','timeline','occasion','customer_profile'];

function validEnum(field, v) {
  return v != null && ENUMS[field] && ENUMS[field].includes(v) ? v : null;
}

function validInternalRcArray(arr) {
  if (!Array.isArray(arr)) return [];
  const filtered = arr.filter(x => INTERNAL_RC_VALID.includes(x));
  return [...new Set(filtered)].slice(0, 3);
}

function validBoolObj(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of keys) {
    if (typeof obj[k] === 'boolean') out[k] = obj[k];
    else out[k] = null;
  }
  return out;
}

function validateTierAOutput(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('invalid tier A output');
  return {
    customer_reason:                 validEnum('customer_reason', raw.customer_reason),
    lead_status:                     validEnum('lead_status', raw.lead_status),
    funnel_stage_lost:               validEnum('funnel_stage_lost', raw.funnel_stage_lost),
    customer_intent:                 validEnum('customer_intent', raw.customer_intent),
    no_response_after:               raw.no_response_after === null ? null : validEnum('no_response_after', raw.no_response_after),
    controllability:                 validEnum('controllability', raw.controllability),
    decision_maker:                  validEnum('decision_maker', raw.decision_maker),
    internal_root_cause_categories:  validInternalRcArray(raw.internal_root_cause_categories),
    sales_handling:                  validBoolObj(raw.sales_handling, SALES_HANDLING_KEYS),
    product_solution_fit:            validBoolObj(raw.product_solution_fit, PRODUCT_FIT_KEYS),
    confidence:                      validEnum('confidence', raw.confidence) || 'medium',
    evidence_quote:                  typeof raw.evidence_quote === 'string' ? raw.evidence_quote.slice(0, 100) : null,
  };
}

module.exports = {
  ENUMS, INTERNAL_RC_VALID, SALES_HANDLING_KEYS, PRODUCT_FIT_KEYS,
  validEnum, validInternalRcArray, validBoolObj, validateTierAOutput,
};
