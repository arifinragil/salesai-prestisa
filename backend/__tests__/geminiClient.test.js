process.env.GEMINI_API_KEY = 'test-dummy-key';

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

const { classifyIntent } = require('../services/geminiClient');

beforeEach(() => { mockGenerateContent.mockReset(); });

test('returns parsed JSON intent', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => '```json\n{"intent":"complaint","confidence":0.92}\n```' },
  });
  const out = await classifyIntent('mau komplain pesanan saya rusak');
  expect(out.intent).toBe('complaint');
  expect(out.confidence).toBe(0.92);
});

test('handles bare JSON without code fence', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => '{"intent":"order_intent","confidence":0.8}' },
  });
  const out = await classifyIntent('mau pesan papan');
  expect(out.intent).toBe('order_intent');
});

test('falls back to "other" when output is unparseable', async () => {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => 'I think this is sad' },
  });
  const out = await classifyIntent('hi');
  expect(out.intent).toBe('other');
  expect(out.confidence).toBe(0);
  expect(out.parseError).toBeDefined();
});

test('returns degraded fallback when API fails', async () => {
  mockGenerateContent.mockRejectedValueOnce(new Error('boom'));
  const out = await classifyIntent('hi');
  expect(out.intent).toBe('unknown');
  expect(out.degraded).toBe(true);
});
