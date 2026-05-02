const { computeNextStage } = require('../services/pipelineEngine');

describe('computeNextStage', () => {
  test('baru + intent_qualified → tertarik', () => {
    expect(computeNextStage('baru', { type: 'intent_qualified' }, false)).toBe('tertarik');
  });
  test('tertarik + order_url_sent → form_dikirim', () => {
    expect(computeNextStage('tertarik', { type: 'order_url_sent' }, false)).toBe('form_dikirim');
  });
  test('baru + order_url_sent → form_dikirim (skip stage)', () => {
    expect(computeNextStage('baru', { type: 'order_url_sent' }, false)).toBe('form_dikirim');
  });
  test('form_dikirim + order_submitted → order_submitted', () => {
    expect(computeNextStage('form_dikirim', { type: 'order_submitted' }, false)).toBe('order_submitted');
  });
  test('order_submitted + order_paid → paid', () => {
    expect(computeNextStage('order_submitted', { type: 'order_paid' }, false)).toBe('paid');
  });
  test('paid + order_delivered → delivered', () => {
    expect(computeNextStage('paid', { type: 'order_delivered' }, false)).toBe('delivered');
  });

  test('any stage + handover_refund → lost', () => {
    expect(computeNextStage('tertarik', { type: 'handover_refund' }, false)).toBe('lost');
    expect(computeNextStage('paid', { type: 'handover_refund' }, false)).toBe('lost');
  });
  test('any stage + handover_cancel → lost', () => {
    expect(computeNextStage('form_dikirim', { type: 'handover_cancel' }, false)).toBe('lost');
  });
  test('any stage + spam_blocked → lost', () => {
    expect(computeNextStage('baru', { type: 'spam_blocked' }, false)).toBe('lost');
  });
  test('tertarik/form_dikirim + stale_no_reply → lost', () => {
    expect(computeNextStage('tertarik', { type: 'stale_no_reply' }, false)).toBe('lost');
    expect(computeNextStage('form_dikirim', { type: 'stale_no_reply' }, false)).toBe('lost');
  });
  test('paid + stale_no_reply → null (not eligible)', () => {
    expect(computeNextStage('paid', { type: 'stale_no_reply' }, false)).toBeNull();
  });

  test('manual override blocks backward auto-transition', () => {
    expect(computeNextStage('tertarik', { type: 'intent_qualified' }, true)).toBeNull();
  });
  test('manual override does NOT block forward auto-transition', () => {
    expect(computeNextStage('tertarik', { type: 'order_url_sent' }, true)).toBe('form_dikirim');
  });
  test('manual override does not block lost transition', () => {
    expect(computeNextStage('tertarik', { type: 'handover_refund' }, true)).toBe('lost');
  });

  test('same stage event returns null', () => {
    expect(computeNextStage('tertarik', { type: 'intent_qualified' }, false)).toBeNull();
  });
  test('order_paid on stage already paid returns null', () => {
    expect(computeNextStage('paid', { type: 'order_paid' }, false)).toBeNull();
  });

  test('lost + customer_replied → tertarik (reactivate)', () => {
    expect(computeNextStage('lost', { type: 'customer_replied' }, false)).toBe('tertarik');
  });
  test('delivered + customer_replied → null (do NOT reactivate)', () => {
    expect(computeNextStage('delivered', { type: 'customer_replied' }, false)).toBeNull();
  });

  test('baru + operator_claim → tertarik', () => {
    expect(computeNextStage('baru', { type: 'operator_claim' }, false)).toBe('tertarik');
  });
  test('form_dikirim + operator_claim → null', () => {
    expect(computeNextStage('form_dikirim', { type: 'operator_claim' }, false)).toBeNull();
  });

  test('baru + stale_baru_no_reply → lost', () => {
    expect(computeNextStage('baru', { type: 'stale_baru_no_reply' }, false)).toBe('lost');
  });
  test('tertarik + stale_baru_no_reply → null (only baru)', () => {
    expect(computeNextStage('tertarik', { type: 'stale_baru_no_reply' }, false)).toBeNull();
  });

  test('unknown event → null', () => {
    expect(computeNextStage('baru', { type: 'unknown_xyz' }, false)).toBeNull();
  });
});
