// backend/services/supervisorSubsections.js
// Pure sub-section classifiers for Supervisor Control Group 1 & 2.

function isCustomerWaiting(lead) {
  return !!lead.last_in_after_out && (lead.awaiting_sales_reply_min || 0) > 10 && !lead.last_in_is_reaction;
}
// 'p1' (no reply yet), 'p3' (slow but replied), or null (fast enough).
function slowFirstResponse(lead) {
  if (lead.no_reply_yet) return 'p1';
  if (lead.first_response_lag_min != null && lead.first_response_lag_min > 1) return 'p3';
  return null;
}
function isCustomerGhost(lead) {
  const h = lead.ghost_hours;
  return h != null && h >= 1 && h < 24;
}
function isBubbleChat(lead) {
  return Number(lead.inbound_count) === 1
    && (lead.last_in_len || 0) < 50
    && (lead.awaiting_customer_reply_min || 0) > 60
    && !lead.last_in_is_reaction;
}

module.exports = { isCustomerWaiting, slowFirstResponse, isCustomerGhost, isBubbleChat };
