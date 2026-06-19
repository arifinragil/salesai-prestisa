const S = require('../services/supervisorSubsections');

describe('supervisorSubsections', () => {
  test('customerWaiting: customer waited ≥ 2 min', () => {
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 22, last_in_after_out: true })).toBe(true);
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 2, last_in_after_out: true })).toBe(true);   // boundary
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 1, last_in_after_out: true })).toBe(false);  // under threshold
    // sales already replied → last msg is outbound → awaiting null → not waiting (regardless of last_in_after_out)
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: null, last_in_after_out: true })).toBe(false);
  });
  test('slowFirstResponse split by no_reply_yet', () => {
    expect(S.slowFirstResponse({ first_response_lag_min: null, no_reply_yet: true })).toBe('p1');
    expect(S.slowFirstResponse({ first_response_lag_min: 5, no_reply_yet: false })).toBe('p3');
    expect(S.slowFirstResponse({ first_response_lag_min: 0.5, no_reply_yet: false })).toBe(null);
  });
  test('customerGhost: sales replied last, ghost 1-24h', () => {
    expect(S.isCustomerGhost({ ghost_hours: 5 })).toBe(true);
    expect(S.isCustomerGhost({ ghost_hours: 0.5 })).toBe(false);
    expect(S.isCustomerGhost({ ghost_hours: 30 })).toBe(false);
  });
  test('bubbleChat: 1 inbound, short body, >1h', () => {
    expect(S.isBubbleChat({ inbound_count: 1, last_in_len: 20, awaiting_customer_reply_min: 90 })).toBe(true);
    expect(S.isBubbleChat({ inbound_count: 3, last_in_len: 20, awaiting_customer_reply_min: 90 })).toBe(false);
  });
  test('customerWaiting excludes reaction/sticker last bubble', () => {
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 22, last_in_after_out: true, last_in_is_reaction: true })).toBe(false);
    expect(S.isCustomerWaiting({ awaiting_sales_reply_min: 22, last_in_after_out: true, last_in_is_reaction: false })).toBe(true);
  });
  test('bubbleChat excludes reaction/sticker bubble', () => {
    expect(S.isBubbleChat({ inbound_count: 1, last_in_len: 20, awaiting_customer_reply_min: 90, last_in_is_reaction: true })).toBe(false);
    expect(S.isBubbleChat({ inbound_count: 1, last_in_len: 20, awaiting_customer_reply_min: 90, last_in_is_reaction: false })).toBe(true);
  });
});
