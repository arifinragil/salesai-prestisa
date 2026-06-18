// backend/services/supervisorRecap.js
function summarize(leads) {
  const total = leads.length;
  const done = leads.filter((l) => l.supervisor_solved).length;
  const reviewed_open = leads.filter((l) => !l.supervisor_solved && l.supervisor_ack_at).length;
  const not_reviewed = leads.filter((l) => !l.supervisor_solved && !l.supervisor_ack_at).length;
  const pct = (n) => total ? Math.round((n / total) * 100) : 0;
  return { total, done, reviewed_open, not_reviewed, compliance_pct: pct(done), coverage_pct: pct(done + reviewed_open) };
}
function matchRate(rows) {
  const reviewed = rows.filter((r) => r.supervisor_agree_with_ai !== undefined && (r.supervisor_agree_with_ai !== null || r.supervisor_ack_at));
  const agreed = reviewed.filter((r) => r.supervisor_agree_with_ai === true || (r.supervisor_agree_with_ai === null && r.supervisor_ack_at)).length;
  const revised = reviewed.filter((r) => r.supervisor_agree_with_ai === false).length;
  const denom = agreed + revised;
  return { reviewed_total: denom, agreed, revised, match_pct: denom ? Math.round((agreed/denom)*100) : 0 };
}
function issueBreakdown(rows) {
  const byCategory = { A:0,B:0,C:0,D:0 };
  for (const r of rows) if (r.stuck_bucket && byCategory[r.stuck_bucket] != null) byCategory[r.stuck_bucket]++;
  return { byCategory, total: rows.length };
}
module.exports = { summarize, matchRate, issueBreakdown };
