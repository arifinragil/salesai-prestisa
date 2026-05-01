jest.mock('../services/waAdapters/wahaAdapter', () => ({
  sendText: jest.fn().mockResolvedValue({ id: 'fake-msg-id' }),
  parseInbound: jest.fn((raw) => ({ phone: '628111111111', body: raw.body, mediaUrl: null, type: 'text' })),
  name: 'waha',
}));

const waClient = require('../services/waClient');

beforeEach(() => { jest.clearAllMocks(); });

test('sendText delegates to active adapter and returns its result', async () => {
  const res = await waClient.sendText({ phone: '628111111111', text: 'halo' });
  expect(res.id).toBe('fake-msg-id');
  const wahaAdapter = require('../services/waAdapters/wahaAdapter');
  expect(wahaAdapter.sendText).toHaveBeenCalledWith({ phone: '628111111111', text: 'halo' });
});

test('parseInbound delegates to active adapter', () => {
  const out = waClient.parseInbound({ body: 'hi' });
  expect(out.phone).toBe('628111111111');
  expect(out.body).toBe('hi');
});

test('throws on unknown WA_PROVIDER', () => {
  jest.resetModules();
  process.env.WA_PROVIDER = 'nonsense';
  expect(() => require('../services/waClient')).toThrow(/unknown WA_PROVIDER/);
  process.env.WA_PROVIDER = 'waha';
});

describe('wahaAdapter.parseInbound (real)', () => {
  const waha = jest.requireActual('../services/waAdapters/wahaAdapter');

  test('extracts phone from wa_jid', () => {
    const out = waha.parseInbound({ wa_jid: '628123456789@c.us', body: 'hi', waha_message_id: 'abc' });
    expect(out.phone).toBe('628123456789');
    expect(out.body).toBe('hi');
    expect(out.wahaMessageId).toBe('abc');
    expect(out.type).toBe('text');
    expect(out.skip).toBeNull();
  });

  test('marks group jids as skip=group', () => {
    const out = waha.parseInbound({ wa_jid: '120363999999@g.us', body: 'hi' });
    expect(out.skip).toBe('group');
  });

  test('marks broadcast as skip=broadcast', () => {
    const out = waha.parseInbound({ wa_jid: 'status@broadcast', body: 'x' });
    expect(out.skip).toBe('broadcast');
  });

  test('detects media attachment', () => {
    const out = waha.parseInbound({ wa_jid: '6281@c.us', media_url: 'https://x/y.jpg', media_mimetype: 'image/jpeg' });
    expect(out.type).toBe('media');
    expect(out.mediaUrl).toBe('https://x/y.jpg');
  });
});
