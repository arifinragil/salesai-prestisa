const { PROMISE_RE, mapPromiseRow, hoursSince } = require('../services/salesPromise');

describe('salesPromise', () => {
  test('PROMISE_RE matches the canonical acceptance case', () => {
    const body = 'Baik ini sedang kami ajukan dlu ya ka, nanti klo sudah keluar harga nya kami infokan kembali';
    expect(PROMISE_RE.test(body)).toBe(true);
  });
  test('PROMISE_RE ignores a plain greeting', () => {
    expect(PROMISE_RE.test('Halo kak, ada yang bisa dibantu?')).toBe(false);
  });
  test('mapPromiseRow computes hours_since_promise and trims body', () => {
    const now = new Date('2026-06-18T10:00:00Z');
    const row = { lotus_id: 'x1', cust_name: 'A', assign_to_user_name: 'Wawa',
      promise_at: '2026-06-18T04:00:00Z', promise_body: 'x'.repeat(300) };
    const out = mapPromiseRow(row, now);
    expect(out.hours_since_promise).toBe(6);
    expect(out.promise_body.length).toBe(240);
    expect(out.lotus_id).toBe('x1');
  });
});
