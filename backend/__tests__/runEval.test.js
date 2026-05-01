jest.mock('../services/geminiClient', () => ({
  classifyIntent: jest.fn(),
  isDangerous: (i) => ['complaint','refund','cancel','angry','legal','explicit_request_human'].includes(i),
}));
jest.mock('../services/claudeClient', () => ({
  generateWithTools: jest.fn(),
}));
jest.mock('../services/aiPersona', () => ({
  buildSystemPrompt: jest.fn().mockResolvedValue('SYS'),
  loadActivePrompt: jest.fn(),
  buildHistoryMessages: jest.fn(() => []),
}));

const gemini = require('../services/geminiClient');
const claude = require('../services/claudeClient');
const { runOne } = require('../scripts/runEval');

beforeEach(() => { gemini.classifyIntent.mockReset(); claude.generateWithTools.mockReset(); });

test('passes when intent matches and handover=false', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'pricing', confidence: 0.9 });
  claude.generateWithTools.mockResolvedValue({
    text: 'mulai 500.000', calls: [{ name: 'search_products', result: { products: [{ price: 500000 }] } }],
    usage: { input_tokens: 10, output_tokens: 5 }, iterationsCapped: false,
  });
  const r = await runOne(
    { id: 1, input: 'berapa harga?', expect: { intent: 'pricing', handover: false, tool_called: 'search_products' } },
    'SYS'
  );
  expect(r.passed).toBe(true);
});

test('fails when intent mismatches', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'other', confidence: 0.5 });
  const r = await runOne(
    { id: 2, input: 'berapa harga?', expect: { intent: 'pricing', handover: false } },
    'SYS'
  );
  expect(r.passed).toBe(false);
  expect(r.reasons[0]).toMatch(/intent mismatch/);
});

test('passes when dangerous intent triggers handover', async () => {
  gemini.classifyIntent.mockResolvedValue({ intent: 'complaint', confidence: 0.95 });
  const r = await runOne(
    { id: 3, input: 'kecewa', expect: { intent: 'complaint', handover: true } },
    'SYS'
  );
  expect(r.passed).toBe(true);
  expect(claude.generateWithTools).not.toHaveBeenCalled();
});
