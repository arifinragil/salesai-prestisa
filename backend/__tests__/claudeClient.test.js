process.env.ANTHROPIC_API_KEY = 'test-dummy-key';

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});

const { generateWithTools } = require('../services/claudeClient');

beforeEach(() => { mockCreate.mockReset(); });

test('returns text when model emits no tool calls', async () => {
  mockCreate.mockResolvedValueOnce({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'halo Kak' }],
    usage: { input_tokens: 100, output_tokens: 5 },
  });
  const out = await generateWithTools({
    systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }],
    tools: [], executor: () => ({}),
  });
  expect(out.text).toBe('halo Kak');
  expect(out.calls).toEqual([]);
  expect(out.usage.input_tokens).toBe(100);
});

test('runs tool then final text', async () => {
  mockCreate
    .mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'cek dulu ya' },
        { type: 'tool_use', id: 'tool_1', name: 'search_products', input: { query: 'mawar' } },
      ],
      usage: { input_tokens: 200, output_tokens: 30 },
    })
    .mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ada 2 pilihan...' }],
      usage: { input_tokens: 250, output_tokens: 50 },
    });

  const executor = jest.fn().mockResolvedValue({ count: 2, products: [{ id: 1 }] });
  const out = await generateWithTools({
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'cari mawar' }],
    tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object', properties: {} } }],
    executor,
  });

  expect(executor).toHaveBeenCalledWith('search_products', { query: 'mawar' });
  expect(out.text).toBe('ada 2 pilihan...');
  expect(out.calls).toHaveLength(1);
  expect(out.calls[0].name).toBe('search_products');
  expect(out.usage.input_tokens).toBe(450);
  expect(out.usage.output_tokens).toBe(80);
});

test('caps at maxIterations', async () => {
  mockCreate.mockResolvedValue({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't', name: 'search_products', input: {} }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const executor = jest.fn().mockResolvedValue({ count: 0 });
  const out = await generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object', properties: {} } }],
    executor, maxIterations: 3,
  });
  expect(out.iterationsCapped).toBe(true);
  expect(out.calls).toHaveLength(3);
});

test('retries on 429 then succeeds', async () => {
  const err429 = new Error('rate limited'); err429.status = 429;
  mockCreate
    .mockRejectedValueOnce(err429)
    .mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  const out = await generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [], executor: () => ({}),
  });
  expect(out.text).toBe('ok');
  expect(mockCreate).toHaveBeenCalledTimes(2);
}, 10000);

test('throws after max retries on persistent 5xx', async () => {
  const err500 = new Error('server'); err500.status = 503;
  mockCreate.mockRejectedValue(err500);
  await expect(generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [], executor: () => ({}),
  })).rejects.toThrow();
}, 15000);

test('tool executor error captured per call (does not abort loop)', async () => {
  mockCreate
    .mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'search_products', input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    .mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'maaf gangguan' }],
      usage: { input_tokens: 20, output_tokens: 10 },
    });
  const executor = jest.fn().mockRejectedValue(new Error('boom'));
  const out = await generateWithTools({
    systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object', properties: {} } }],
    executor,
  });
  expect(out.calls[0].error).toBe('boom');
  expect(out.text).toBe('maaf gangguan');
});
