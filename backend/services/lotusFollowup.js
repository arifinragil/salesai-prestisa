// backend/services/lotusFollowup.js
// Logika murni FU tracking Lotus: hitung status follow-up satu lead dari
// first_inbound_at (anchor) + last_outbound_at (deteksi 'sudah di-FU'). Tanpa DB.

const FU_CYCLES = [1, 3, 5];   // hari: H+1, H+3, H+5
const FU_CAP_DAYS = 7;         // lewat ini → expired (urusan data-pending)
const DAY_MS = 24 * 3600 * 1000;

function asMs(v) { const t = (v instanceof Date ? v : new Date(v)).getTime(); return Number.isNaN(t) ? null : t; }

function followupState(item, now) {
  const nowMs = asMs(now);
  const anchor = item.first_inbound_at != null ? asMs(item.first_inbound_at) : null;
  if (anchor == null) {
    return { in_fu: false, current_cycle: 0, status: 'fresh', next_due_at: null, overdue_since: null };
  }
  const dues = FU_CYCLES.map((d) => anchor + d * DAY_MS);
  const cap = anchor + FU_CAP_DAYS * DAY_MS;
  const current_cycle = dues.filter((d) => d <= nowMs).length;
  const nextDueMs = dues.find((d) => d > nowMs);
  const next_due_at = nextDueMs ? new Date(nextDueMs) : null;

  if (current_cycle === 0) {
    return { in_fu: true, current_cycle: 0, status: 'fresh', next_due_at, overdue_since: null };
  }

  const lastDue = dues[current_cycle - 1];
  const lastOut = item.last_outbound_at != null ? asMs(item.last_outbound_at) : null;
  const done = lastOut != null && lastOut >= lastDue;

  if (nowMs > cap && !done) {
    return { in_fu: false, current_cycle, status: 'expired', next_due_at: null, overdue_since: new Date(lastDue) };
  }
  if (done) {
    const status = current_cycle === FU_CYCLES.length ? 'done' : 'pending';
    return { in_fu: true, current_cycle, status, next_due_at, overdue_since: null };
  }
  return { in_fu: true, current_cycle, status: 'overdue', next_due_at, overdue_since: new Date(lastDue) };
}

module.exports = { followupState, FU_CYCLES, FU_CAP_DAYS };
