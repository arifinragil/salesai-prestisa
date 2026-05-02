// Shared constants for pipeline. Imported by pipelineEngine, routes, scripts, tests.

const STAGES = ['baru', 'tertarik', 'form_dikirim', 'order_submitted', 'paid', 'delivered', 'lost'];

const STAGE_ORDER = {
  baru: 0,
  tertarik: 1,
  form_dikirim: 2,
  order_submitted: 3,
  paid: 4,
  delivered: 5,
  // lost is orthogonal — no order
};

const STAGE_PROBABILITY = {
  baru: 0.05,
  tertarik: 0.15,
  form_dikirim: 0.35,
  order_submitted: 0.70,
  paid: 0.95,
  delivered: 1.00,
  lost: 0.00,
};

const TYPES = ['papan', 'bouquet', 'parsel', 'cake', 'wedding', 'b2b', 'unknown'];

const LOST_REASONS = [
  'no_reply',
  'harga_terlalu_tinggi',
  'kompetitor',
  'produk_tidak_cocok',
  'timing_tidak_pas',
  'cancelled',
  'refund_complaint',
  'other_with_note',
];

const TERMINAL_STAGES = new Set(['delivered', 'lost']);

function isStageForward(from, to) {
  if (to === 'lost') return false;
  if (from === 'lost') return false;
  const fromOrder = STAGE_ORDER[from];
  const toOrder = STAGE_ORDER[to];
  if (fromOrder == null || toOrder == null) return false;
  return toOrder > fromOrder;
}

module.exports = {
  STAGES, STAGE_ORDER, STAGE_PROBABILITY, TYPES, LOST_REASONS, TERMINAL_STAGES, isStageForward,
};
