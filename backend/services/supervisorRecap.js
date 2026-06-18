// backend/services/supervisorRecap.js
function summarize(leads) {
  const total = leads.length;
  const done = leads.filter((l) => l.supervisor_solved).length;
  const reviewed_open = leads.filter((l) => !l.supervisor_solved && l.supervisor_ack_at).length;
  const not_reviewed = leads.filter((l) => !l.supervisor_solved && !l.supervisor_ack_at).length;
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;
  return { total, done, reviewed_open, not_reviewed, compliance_pct: pct(done), coverage_pct: pct(done + reviewed_open) };
}
module.exports = { summarize };
