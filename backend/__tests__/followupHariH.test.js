const { expectedCycle } = require('../services/followupHariH');

const H = (n) => new Date(`2026-06-18T0${n}:00:00Z`); // helper, 0-9h
describe('followupHariH.expectedCycle', () => {
  const now = new Date('2026-06-18T09:30:00Z');
  test('cycle 1 overdue: inbound >2h ago, no FU yet', () => {
    expect(expectedCycle({ first_inbound_at: H(6), fu_times: [] }, now)).toBe(1);
  });
  test('cycle 1 not yet due: inbound <2h ago', () => {
    const recent = new Date('2026-06-18T08:00:00Z'); // 1.5h before now
    expect(expectedCycle({ first_inbound_at: recent, fu_times: [] }, now)).toBe(null);
  });
  test('cycle 2 overdue: cycle-1 FU done >4h ago, no cycle-2', () => {
    expect(expectedCycle({ first_inbound_at: H(1), fu_times: [H(3)] }, now)).toBe(2);
  });
  test('cycle 3 overdue: two FUs, second >8h ago', () => {
    const t1 = new Date('2026-06-18T00:30:00Z');
    const t2 = new Date('2026-06-18T01:00:00Z');
    const late = new Date('2026-06-18T10:00:00Z'); // >8h after t2
    expect(expectedCycle({ first_inbound_at: new Date('2026-06-17T23:00:00Z'), fu_times: [t1, t2] }, late)).toBe(3);
  });
  test('all cycles done recently: no expected cycle', () => {
    const t = [new Date('2026-06-18T09:00:00Z'), new Date('2026-06-18T09:10:00Z'), new Date('2026-06-18T09:20:00Z')];
    expect(expectedCycle({ first_inbound_at: H(6), fu_times: t }, now)).toBe(null);
  });
});
