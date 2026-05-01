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

  describe('native WAHA event envelope', () => {
    test('parses message event with text body', () => {
      const out = waha.parseInbound({
        event: 'message', session: 'finance0000',
        payload: { id: 'false_628_3EB', from: '628123456789@c.us', fromMe: false, body: 'halo native', hasMedia: false },
      });
      expect(out.phone).toBe('628123456789');
      expect(out.body).toBe('halo native');
      expect(out.wahaMessageId).toBe('false_628_3EB');
      expect(out.type).toBe('text');
      expect(out.skip).toBeNull();
    });

    test('extracts body from message.conversation if root body missing', () => {
      const out = waha.parseInbound({
        event: 'message',
        payload: { id: 'x', from: '628@c.us', fromMe: false, message: { conversation: 'nested halo' } },
      });
      expect(out.body).toBe('nested halo');
    });

    test('extracts body from extendedTextMessage', () => {
      const out = waha.parseInbound({
        event: 'message',
        payload: { id: 'x', from: '628@c.us', fromMe: false, message: { extendedTextMessage: { text: 'halo ext' } } },
      });
      expect(out.body).toBe('halo ext');
    });

    test('skips fromMe (outbound echo)', () => {
      const out = waha.parseInbound({
        event: 'message', payload: { id: 'x', from: '628@c.us', fromMe: true, body: 'echo' },
      });
      expect(out.skip).toBe('fromMe');
    });

    test('skips non-message events', () => {
      const out = waha.parseInbound({ event: 'session.status', payload: { status: 'WORKING' } });
      expect(out.skip).toBe('event:session.status');
    });

    test('detects native media payload', () => {
      const out = waha.parseInbound({
        event: 'message',
        payload: {
          id: 'x', from: '628@c.us', fromMe: false, hasMedia: true,
          media: { mimetype: 'image/jpeg', url: 'https://x/y.jpg' },
        },
      });
      expect(out.type).toBe('image');
      expect(out.mediaUrl).toBe('https://x/y.jpg');
    });
  });
});
