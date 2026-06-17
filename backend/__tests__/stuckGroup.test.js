// backend/__tests__/stuckGroup.test.js
const { STUCK_GROUP_OF, bucketOfGroup } = require('../services/stuckGroup');

test('root cause → group', () => {
  expect(STUCK_GROUP_OF('harga_terlalu_mahal')).toBe('customer');
  expect(STUCK_GROUP_OF('respon_lambat')).toBe('sales');
  expect(STUCK_GROUP_OF('area_pengiriman')).toBe('offer');
  expect(STUCK_GROUP_OF('lainnya')).toBe('proses');
});

test('group → bucket', () => {
  expect(bucketOfGroup('customer')).toBe('A');
  expect(bucketOfGroup('sales')).toBe('B');
  expect(bucketOfGroup('offer')).toBe('C');
  expect(bucketOfGroup('proses')).toBe('D');
});
