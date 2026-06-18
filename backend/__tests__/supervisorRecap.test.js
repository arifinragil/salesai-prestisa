const { summarize } = require('../services/supervisorRecap');
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
