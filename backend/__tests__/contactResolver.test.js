jest.mock('../db/mysql', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
}));

const mysql = require('../db/mysql');
const { normalizePhone, jidToPhone, resolveByPhone } = require('../services/contactResolver');

beforeEach(() => { mysql.query.mockReset(); });

describe('normalizePhone', () => {
  test('0xxxx -> 62xxxx', () => expect(normalizePhone('081234567890')).toBe('6281234567890'));
  test('8xxxx -> 628xxxx', () => expect(normalizePhone('81234567890')).toBe('6281234567890'));
  test('+62 form preserved', () => expect(normalizePhone('+6281234567890')).toBe('6281234567890'));
  test('non-digit chars stripped', () => expect(normalizePhone('+62 812-3456-7890')).toBe('6281234567890'));
  test('null/empty returns null', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});

describe('jidToPhone', () => {
  test('strips @c.us suffix', () => expect(jidToPhone('6281234567890@c.us')).toBe('6281234567890'));
  test('strips @s.whatsapp.net suffix', () => expect(jidToPhone('6281234567890@s.whatsapp.net')).toBe('6281234567890'));
  test('null returns null', () => expect(jidToPhone(null)).toBeNull());
});

describe('resolveByPhone', () => {
  test('returns customer match when found', async () => {
    mysql.query.mockResolvedValueOnce([[{ id: 42, name: 'Andi', phone: '6281234567890' }]]);
    const out = await resolveByPhone('6281234567890');
    expect(out).toEqual({ customer_id: 42, name: 'Andi' });
  });

  test('returns null when not found', async () => {
    mysql.query.mockResolvedValueOnce([[]]);
    const out = await resolveByPhone('6280000000000');
    expect(out).toEqual({ customer_id: null, name: null });
  });

  test('null phone returns empty result', async () => {
    const out = await resolveByPhone(null);
    expect(out).toEqual({ customer_id: null, name: null });
    expect(mysql.query).not.toHaveBeenCalled();
  });
});
