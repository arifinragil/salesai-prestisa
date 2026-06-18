const { summarize, matchRate, issueBreakdown } = require('../services/supervisorRecap');
test('summarize computes coverage and compliance', () => {
  const leads = [
    { supervisor_solved: true,  supervisor_ack_at: 'x' },
    { supervisor_solved: false, supervisor_ack_at: 'x' },
    { supervisor_solved: false, supervisor_ack_at: null },
    { supervisor_solved: false, supervisor_ack_at: null },
  ];
  const s = summarize(leads);
  expect(s.total).toBe(4);
  expect(s.done).toBe(1);
  expect(s.reviewed_open).toBe(1);
  expect(s.not_reviewed).toBe(2);
  expect(s.compliance_pct).toBe(25);
  expect(s.coverage_pct).toBe(50);
});
test('matchRate = agreed/(agreed+revised), legacy null agree counts as agreed', () => {
  const rows = [
    { supervisor_agree_with_ai: true }, { supervisor_agree_with_ai: false },
    { supervisor_agree_with_ai: null, supervisor_ack_at: 'x' }, // legacy implied agree
  ];
  const m = matchRate(rows);
  expect(m.agreed).toBe(2); expect(m.revised).toBe(1); expect(m.match_pct).toBe(67);
});
test('issueBreakdown counts by bucket', () => {
  const rows = [{ stuck_bucket:'A' },{ stuck_bucket:'A' },{ stuck_bucket:'C' },{ stuck_bucket:null }];
  const b = issueBreakdown(rows);
  expect(b.byCategory.A).toBe(2); expect(b.byCategory.C).toBe(1); expect(b.total).toBe(4);
});
