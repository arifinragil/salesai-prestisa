const { scoreReply, shouldEscalate } = require('../services/aiConfidence');

test('high score for clean reply with successful tools', () => {
  const s = scoreReply({
    reply: 'Pilihan papan sukacita 750.000 ya Kak. Mau diproses sekarang?',
    toolCalls: [{ name: 'search_products', result: { count: 2, products: [{ price: 750000 }] } }],
    intent: 'order_intent',
    iterationsCapped: false,
  });
  expect(s).toBeGreaterThanOrEqual(0.7);
});

test('low score for empty reply', () => {
  const s = scoreReply({ reply: '', toolCalls: [], intent: 'other', iterationsCapped: false });
  expect(s).toBeLessThan(0.5);
});

test('low score when iterations capped', () => {
  const s = scoreReply({
    reply: 'oke', toolCalls: [{ name: 'x', result: {} }], intent: 'other', iterationsCapped: true,
  });
  expect(s).toBeLessThan(0.7);
});

test('low score when all tools failed', () => {
  const s = scoreReply({
    reply: 'oke',
    toolCalls: [
      { name: 'search_products', error: 'boom' },
      { name: 'get_shipping_info', error: 'boom' },
    ],
    intent: 'order_intent',
    iterationsCapped: false,
  });
  expect(s).toBeLessThan(0.6);
});

test('shouldEscalate true when score below threshold', () => {
  expect(shouldEscalate(0.5)).toBe(true);
  expect(shouldEscalate(0.85)).toBe(false);
});

test('shouldEscalate respects AI_CONFIDENCE_THRESHOLD env', () => {
  const orig = process.env.AI_CONFIDENCE_THRESHOLD;
  process.env.AI_CONFIDENCE_THRESHOLD = '0.9';
  expect(shouldEscalate(0.85)).toBe(true);
  process.env.AI_CONFIDENCE_THRESHOLD = orig || '';
});
