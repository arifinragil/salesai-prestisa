jest.mock('../db/postgres');
jest.mock('../services/embedClient', () => ({
  embed: jest.fn(async (arr) => arr.map(() => [1, 0, 0])),
  cosine: jest.requireActual('../services/embedClient').cosine,
}));
const pg = require('../db/postgres');
const { retrieveSimilar } = require('../services/qnaRag');

test('retrieveSimilar ranking + minScore', async () => {
  pg.query.mockResolvedValueOnce({ rows: [
    { id: 1, question: 'harga papan?', answer: 'mulai 300rb', embedding: [1, 0, 0] },
    { id: 2, question: 'jam buka?',     answer: 'Senin-Sabtu', embedding: [0, 1, 0] },
  ] });
  pg.query.mockResolvedValueOnce({ rowCount: 1 });
  const out = await retrieveSimilar('berapa harga papan', { k: 3, minScore: 0.5 });
  expect(out.map((r) => r.id)).toEqual([1]);
  expect(out[0].score).toBeCloseTo(1, 5);
});
