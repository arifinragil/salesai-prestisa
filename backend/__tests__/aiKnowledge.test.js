const { getFaqTopic, listFaqTopics } = require('../services/aiKnowledge');

test('listFaqTopics returns the curated set', () => {
  const topics = listFaqTopics();
  expect(topics).toEqual(expect.arrayContaining([
    'payment', 'refund_policy', 'cancel_policy', 'hours',
    'lead_time', 'area_coverage', 'shipping_fee', 'product_type',
    'how_to_order', 'invoice', 'about',
  ]));
});

test('getFaqTopic returns text for known topic', () => {
  const text = getFaqTopic('payment');
  expect(typeof text).toBe('string');
  expect(text.length).toBeGreaterThan(20);
  expect(text.toLowerCase()).toMatch(/transfer|va|virtual account|qris/);
});

test('getFaqTopic returns null for unknown topic', () => {
  expect(getFaqTopic('nonsense')).toBeNull();
});
