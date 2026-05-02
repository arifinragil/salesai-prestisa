// Sales pipeline engine. Pure stage-transition logic + DB writers.
const pg = require('../db/postgres');
const logger = require('./logger');
const {
  STAGE_PROBABILITY, TERMINAL_STAGES, isStageForward,
} = require('./pipelineConstants');

// Event → resulting stage (without override consideration).
// Returns null if the event has no defined transition for the current stage.
function rawTransition(currentStage, event) {
  const t = event.type;

  // Lost transitions — orthogonal, win against current stage
  if (t === 'handover_refund' || t === 'handover_cancel' || t === 'spam_blocked') {
    return currentStage === 'lost' ? null : 'lost';
  }
  if (t === 'stale_no_reply') {
    if (currentStage === 'tertarik' || currentStage === 'form_dikirim') return 'lost';
    return null;
  }
  if (t === 'stale_baru_no_reply') {
    if (currentStage === 'baru') return 'lost';
    return null;
  }

  // Reactivation: only from lost (delivered intentionally excluded)
  if (t === 'customer_replied') {
    if (currentStage === 'lost') return 'tertarik';
    return null;
  }

  // Forward auto-transitions
  if (t === 'intent_qualified') {
    if (currentStage === 'baru') return 'tertarik';
    return null;
  }
  if (t === 'operator_claim') {
    if (currentStage === 'baru') return 'tertarik';
    return null;
  }
  if (t === 'order_url_sent') {
    if (currentStage === 'baru' || currentStage === 'tertarik') return 'form_dikirim';
    return null;
  }
  if (t === 'order_submitted') {
    if (['baru', 'tertarik', 'form_dikirim'].includes(currentStage)) return 'order_submitted';
    return null;
  }
  if (t === 'order_paid') {
    if (currentStage === 'order_submitted') return 'paid';
    return null;
  }
  if (t === 'order_delivered') {
    if (currentStage === 'paid') return 'delivered';
    return null;
  }

  return null;
}

// Compute target stage applying override semantics.
// Returns null if no transition (no-op).
function computeNextStage(currentStage, event, manualOverride) {
  const target = rawTransition(currentStage, event);
  if (target == null) return null;
  if (target === currentStage) return null;

  // Lost always wins (manual or not)
  if (target === 'lost') return target;

  // Reactivation always wins
  if (currentStage === 'lost') return target;

  // Manual override only blocks non-forward auto-transitions
  if (manualOverride && !isStageForward(currentStage, target)) {
    return null;
  }

  return target;
}

module.exports = {
  computeNextStage,
  rawTransition,
  STAGE_PROBABILITY,
  TERMINAL_STAGES,
};
