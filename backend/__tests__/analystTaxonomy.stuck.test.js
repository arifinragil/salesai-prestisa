const { validateTierAOutput, ENUMS } = require('../services/analystTaxonomy');
test('stuck_group enum ada', () => {
  expect(ENUMS.stuck_group).toEqual(['customer', 'sales', 'offer', 'proses']);
});
test('validateTierAOutput memuat stuck_group + stuck_issue', () => {
  const r = validateTierAOutput({ customer_reason: 'harga_terlalu_mahal', stuck_group: 'customer', stuck_issue: 'keberatan harga', confidence: 'high' });
  expect(r.stuck_group).toBe('customer');
  expect(r.stuck_issue).toBe('keberatan harga');
});
test('stuck_group invalid → null; stuck_issue non-string → null', () => {
  const r = validateTierAOutput({ stuck_group: 'xxx', stuck_issue: 123, confidence: 'low' });
  expect(r.stuck_group).toBeNull();
  expect(r.stuck_issue).toBeNull();
});
