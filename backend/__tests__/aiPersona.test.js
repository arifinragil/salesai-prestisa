jest.mock('../db/postgres', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../db/mysql', () => ({ query: jest.fn(), end: jest.fn().mockResolvedValue(undefined) }));

const pg = require('../db/postgres');
const mysql = require('../db/mysql');
const { loadActivePrompt, buildSystemPrompt, buildHistoryMessages } = require('../services/aiPersona');

beforeEach(() => { pg.query.mockReset(); mysql.query.mockReset(); });

test('loadActivePrompt returns text from active row', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ name: 'tiara_v1', prompt_text: 'Kamu adalah TIARA...' }] });
  const out = await loadActivePrompt();
  expect(out.name).toBe('tiara_v1');
  expect(out.prompt_text).toMatch(/TIARA/);
});

test('loadActivePrompt throws if none active', async () => {
  pg.query.mockResolvedValueOnce({ rows: [] });
  await expect(loadActivePrompt()).rejects.toThrow(/no active persona/);
});

test('buildSystemPrompt appends dynamic context block', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ name: 'tiara_v1', prompt_text: 'BASE PROMPT' }] });
  mysql.query.mockResolvedValueOnce([[
    { id: 100, order_number: 'ORD-100', total: 500000, status: 'approved', created_at: new Date('2026-04-01') },
  ]]);
  const out = await buildSystemPrompt({
    conv: { id: 1, phone: '628111', customer_id: 7, last_intent: 'pricing' },
    customerName: 'Andi',
    cityHint: 'Jakarta',
  });
  expect(out).toMatch(/BASE PROMPT/);
  expect(out).toMatch(/Andi/);
  expect(out).toMatch(/Jakarta/);
  expect(out).toMatch(/ORD-100/);
});

test('buildSystemPrompt works for unknown customer (no orders)', async () => {
  pg.query.mockResolvedValueOnce({ rows: [{ name: 'tiara_v1', prompt_text: 'BASE' }] });
  const out = await buildSystemPrompt({
    conv: { id: 1, phone: '628999', customer_id: null },
    customerName: null,
    cityHint: null,
  });
  expect(out).toMatch(/BASE/);
  expect(out).toMatch(/customer baru/i);
  expect(mysql.query).not.toHaveBeenCalled();
});

test('buildHistoryMessages converts crm_messages rows to anthropic format', () => {
  const rows = [
    { direction: 'in',  sender_type: 'customer', body: 'halo' },
    { direction: 'out', sender_type: 'ai',       body: 'halo Kak' },
    { direction: 'out', sender_type: 'staff',    body: '(operator) ya' },
    { direction: 'in',  sender_type: 'customer', body: 'mau pesan' },
  ];
  const msgs = buildHistoryMessages(rows);
  expect(msgs).toHaveLength(4);
  expect(msgs[0]).toEqual({ role: 'user', content: 'halo' });
  expect(msgs[1]).toEqual({ role: 'assistant', content: 'halo Kak' });
  expect(msgs[2]).toEqual({ role: 'assistant', content: '[operator] (operator) ya' });
  expect(msgs[3]).toEqual({ role: 'user', content: 'mau pesan' });
});

test('buildHistoryMessages skips empty bodies', () => {
  const rows = [
    { direction: 'in', sender_type: 'customer', body: null },
    { direction: 'in', sender_type: 'customer', body: '' },
    { direction: 'in', sender_type: 'customer', body: 'real' },
  ];
  const msgs = buildHistoryMessages(rows);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].content).toBe('real');
});
