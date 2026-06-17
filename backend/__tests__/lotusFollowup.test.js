// backend/__tests__/lotusFollowup.test.js
const { followupState, FU_CYCLES, FU_CAP_DAYS } = require('../services/lotusFollowup');

const NOW = new Date('2026-06-17T00:00:00Z');
const DAY = 24 * 3600 * 1000;
const daysAgo = (d) => new Date(NOW.getTime() - d * DAY).toISOString();

describe('followupState', () => {
  test('tanpa first_inbound_at → fresh, in_fu false', () => {
    const s = followupState({ first_inbound_at: null, last_outbound_at: null }, NOW);
    expect(s.status).toBe('fresh');
    expect(s.in_fu).toBe(false);
  });

  test('lead < H+1 → fresh, next_due_at terisi', () => {
    const s = followupState({ first_inbound_at: daysAgo(0.5), last_outbound_at: null }, NOW);
    expect(s.status).toBe('fresh');
    expect(s.current_cycle).toBe(0);
    expect(s.next_due_at).not.toBeNull();
  });

  test('lead H+2 tanpa pesan keluar → overdue (cycle 1)', () => {
    const s = followupState({ first_inbound_at: daysAgo(2), last_outbound_at: null }, NOW);
    expect(s.status).toBe('overdue');
    expect(s.current_cycle).toBe(1);
    expect(s.overdue_since).not.toBeNull();
  });

  test('lead H+2, sales kirim setelah H+1 → pending (cycle ini selesai)', () => {
    const s = followupState({ first_inbound_at: daysAgo(2), last_outbound_at: daysAgo(0.5) }, NOW);
    expect(s.status).toBe('pending');
    expect(s.current_cycle).toBe(1);
  });

  test('lead H+6, semua cycle dijawab → done', () => {
    const s = followupState({ first_inbound_at: daysAgo(6), last_outbound_at: daysAgo(0.1) }, NOW);
    expect(s.status).toBe('done');
    expect(s.current_cycle).toBe(3);
  });

  test('lead H+10 tanpa FU → expired (lewat cap)', () => {
    const s = followupState({ first_inbound_at: daysAgo(10), last_outbound_at: null }, NOW);
    expect(s.status).toBe('expired');
    expect(s.in_fu).toBe(false);
  });

  test('konstanta cadence', () => {
    expect(FU_CYCLES).toEqual([1, 3, 5]);
    expect(FU_CAP_DAYS).toBe(7);
  });
});
