// backend/services/followupHariH.js
// Derive a 3-cycle "follow up hari H" overdue signal purely from message timing.
// No outcomes table: cycles are counted from human-sales FU outbound timestamps today.

const HOURS = (h) => h * 3600000;
const SLA = { c1: HOURS(2), c2: HOURS(4), c3: HOURS(8) }; // tunable per SLA

// lead: { first_inbound_at, fu_times: Date[] ascending (human-sales outbound today) }
// Returns 1 | 2 | 3 | null (next overdue cycle).
function expectedCycle(lead, now = new Date()) {
  const t = (x) => (x ? new Date(x).getTime() : null);
  const inbound = t(lead.first_inbound_at);
  const fu = (lead.fu_times || []).map(t).filter(Boolean).sort((a, b) => a - b);
  const n = now.getTime();
  if (!inbound) return null;
  // cycle 3: 2 FUs done, second one older than 8h, no 3rd
  if (fu.length >= 2 && n - fu[1] > SLA.c3 && fu.length < 3) return 3;
  // cycle 2: 1 FU done, older than 4h, no 2nd
  if (fu.length >= 1 && n - fu[0] > SLA.c2 && fu.length < 2) return 2;
  // cycle 1: no FU yet, inbound older than 2h
  if (fu.length === 0 && n - inbound > SLA.c1) return 1;
  return null;
}

module.exports = { expectedCycle, SLA };
