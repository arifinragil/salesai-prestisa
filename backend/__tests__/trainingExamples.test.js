const { pickExamples, formatExamplesBlock } = require('../services/trainingExamples');
describe('trainingExamples', () => {
  const rows = [
    { id:1, category:'customer', case_pattern:'a', analysis:'A', usage_count:5, last_used_at:'2026-06-10' },
    { id:2, category:'customer', case_pattern:'b', analysis:'B', usage_count:1, last_used_at:'2026-06-17' },
    { id:3, category:'customer', case_pattern:'c', analysis:'C', usage_count:0, last_used_at:null },
    { id:4, category:'sales_handling', case_pattern:'d', analysis:'D', usage_count:2, last_used_at:'2026-06-15' },
  ];
  test('max 2 per category, limit total', () => {
    const out = pickExamples(rows, { limit: 5, perCategory: 2 });
    const cust = out.filter((r) => r.category === 'customer');
    expect(cust.length).toBe(2);
    expect(out.length).toBe(3); // 2 customer + 1 sales
  });
  test('formatExamplesBlock empty -> empty string', () => {
    expect(formatExamplesBlock([])).toBe('');
  });
  test('formatExamplesBlock includes case + analysis', () => {
    const b = formatExamplesBlock([rows[0]]);
    expect(b).toContain('Case: a');
    expect(b).toContain('Analisa: A');
  });
});
