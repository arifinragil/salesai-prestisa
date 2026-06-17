// backend/__tests__/supervisorPriority.test.js
const { classify, STUCK_MAP } = require('../services/supervisorPriority');
const base = (o = {}) => ({ status: 'active', never_responded: false, awaiting_sales_reply_min: null,
  awaiting_customer_reply_min: null, first_response_lag_min: null, single_bubble: false, fu_status: 'done',
  lead_temperature: 'warm', lead_score: 10, last_intent: null, customer_intent: null, root_cause_tag: null,
  funnel_stage_lost: null, asked_price: false, ...o });

describe('priority', () => {
  test('belum direspons → P1 + sales_response_risk', () => {
    const r = classify(base({ never_responded: true }));
    expect(r.priority).toBe('P1'); expect(r.groups).toContain('sales_response_risk');
  });
  test('customer nunggu >10 mnt → P1', () => {
    expect(classify(base({ awaiting_sales_reply_min: 18 })).priority).toBe('P1');
  });
  test('customer diam >60 mnt → P2 + follow_up', () => {
    const r = classify(base({ awaiting_customer_reply_min: 120 }));
    expect(r.priority).toBe('P2'); expect(r.groups).toContain('follow_up');
  });
  test('FU overdue → P2', () => {
    expect(classify(base({ fu_status: 'overdue' })).priority).toBe('P2');
  });
  test('single bubble → P3 + follow_up', () => {
    const r = classify(base({ single_bubble: true }));
    expect(r.priority).toBe('P3'); expect(r.groups).toContain('follow_up');
  });
  test('tidak ada sinyal → priority null', () => {
    expect(classify(base()).priority).toBeNull();
  });
  test('status closed → null semua', () => {
    expect(classify(base({ status: 'closed', never_responded: true })).priority).toBeNull();
  });
});

describe('lead_stuck bucket', () => {
  test('harga_terlalu_mahal → bucket A', () => {
    const r = classify(base({ root_cause_tag: 'harga_terlalu_mahal' }));
    expect(r.groups).toContain('lead_stuck'); expect(r.stuck_bucket).toBe('A');
    expect(r.stuck_label).toMatch(/harga/i);
  });
  test('respon_lambat → bucket B', () => {
    expect(classify(base({ root_cause_tag: 'respon_lambat' })).stuck_bucket).toBe('B');
  });
  test('barang_tidak_tersedia → bucket C', () => {
    expect(classify(base({ root_cause_tag: 'barang_tidak_tersedia' })).stuck_bucket).toBe('C');
  });
  test('funnel_stage tanpa map dikenal → bucket D', () => {
    expect(classify(base({ funnel_stage_lost: 'quotation' })).stuck_bucket).toBe('D');
  });
  test('sudah_closing → bukan lead_stuck', () => {
    const r = classify(base({ root_cause_tag: 'sudah_closing' }));
    expect(r.groups).not.toContain('lead_stuck'); expect(r.stuck_bucket).toBeNull();
  });
});
