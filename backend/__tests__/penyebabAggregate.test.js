'use strict';
const { aggregate } = require('../services/penyebabAggregate');

// Three sample rows covering different branches
const ROWS = [
  {
    // non-closing, tagged, structured, churn
    lotus_id: 'L1',
    cust_number: '628111111111',
    is_closing: false,
    churn: true,
    issue: 'Harga, Promo & Payment',
    sub_issue: 'Budget tidak cukup',
    rinci: 'Harga start terlalu tinggi',
    analisa: {
      issue_tree: { issue: 'Harga, Promo & Payment', sub_issue: 'Budget tidak cukup', rinci: 'Harga start terlalu tinggi', detail: 'Customer bilang terlalu mahal' },
      pov_sales: {
        good: ['Respon cepat dan ramah'],
        problem: ['Tidak menawarkan alternatif produk lain'],
      },
      action: {
        next_actions: [
          { priority: 'P1', action: 'Follow up ulang besok', deadline: '2026-06-19' },
          { priority: 'P2', action: 'Tawarkan promo diskon', deadline: '2026-06-20' },
        ],
      },
    },
  },
  {
    // non-closing (null), tagged, structured, no churn
    lotus_id: 'L2',
    cust_number: '628222222222',
    is_closing: null,
    churn: false,
    issue: 'Sales Handling & Follow Up',
    sub_issue: 'Telat response',
    rinci: 'Response pertama >1 menit',
    analisa: {
      issue_tree: { issue: 'Sales Handling & Follow Up', sub_issue: 'Telat response', rinci: 'Response pertama >1 menit', detail: 'Sales baru balas 5 menit' },
      pov_sales: {
        good: ['Penjelasan detail dan jelas'],
        problem: ['Respon lambat, tidak konfirmasi'],
      },
      action: {
        next_actions: [
          { priority: 'P1', action: 'Buat SOP template balasan cepat', deadline: '2026-06-18' },
        ],
      },
    },
  },
  {
    // is_closing=true, no analisa, no issue
    lotus_id: 'L3',
    cust_number: '628333333333',
    is_closing: true,
    churn: false,
    issue: null,
    sub_issue: null,
    rinci: null,
    analisa: null,
  },
];

describe('aggregate()', () => {
  let result;
  beforeAll(() => { result = aggregate(ROWS); });

  test('totals.nonClosing counts is_closing false and null', () => {
    expect(result.totals.nonClosing).toBe(2); // L1 (false) + L2 (null)
  });

  test('totals.churn counts churn===true', () => {
    expect(result.totals.churn).toBe(1); // L1
  });

  test('totals.structuredCount counts rows with analisa', () => {
    expect(result.totals.structuredCount).toBe(2); // L1 + L2
  });

  test('totals.taggedCount counts rows with issue not null', () => {
    expect(result.totals.taggedCount).toBe(2); // L1 + L2
  });

  test('issueTree contains Harga issue with correct nesting', () => {
    const harga = result.issueTree.find(i => i.issue === 'Harga, Promo & Payment');
    expect(harga).toBeDefined();
    expect(harga.count).toBe(1);

    const sub = harga.subs.find(s => s.subIssue === 'Budget tidak cukup');
    expect(sub).toBeDefined();
    expect(sub.count).toBe(1);

    const rinci = sub.rinci.find(r => r.rinci === 'Harga start terlalu tinggi');
    expect(rinci).toBeDefined();
    expect(rinci.count).toBe(1);
    expect(rinci.leads).toHaveLength(1);
    expect(rinci.leads[0].phone).toBe('628111111111');
    expect(rinci.leads[0].detail).toBe('Customer bilang terlalu mahal');
  });

  test('issueTree contains Sales Handling issue', () => {
    const sales = result.issueTree.find(i => i.issue === 'Sales Handling & Follow Up');
    expect(sales).toBeDefined();
    expect(sales.count).toBe(1);
  });

  test('priorityCounts aggregates across all rows', () => {
    expect(result.priorityCounts.p1).toBe(2); // L1 + L2
    expect(result.priorityCounts.p2).toBe(1); // L1
    expect(result.priorityCounts.p3).toBe(0);
  });

  test('salesStrengths is non-empty array of {theme,count}', () => {
    expect(Array.isArray(result.salesStrengths)).toBe(true);
    expect(result.salesStrengths.length).toBeGreaterThan(0);
    expect(result.salesStrengths[0]).toHaveProperty('theme');
    expect(result.salesStrengths[0]).toHaveProperty('count');
  });

  test('salesProblems is non-empty array', () => {
    expect(result.salesProblems.length).toBeGreaterThan(0);
  });

  test('actionThemes is non-empty array', () => {
    expect(result.actionThemes.length).toBeGreaterThan(0);
  });

  test('penyebabDist entries match issueTree issues', () => {
    const issueNames = result.issueTree.map(i => i.issue);
    const distNames = result.penyebabDist.map(d => d.category);
    expect(distNames).toEqual(issueNames);
  });

  test('empty input returns zero totals', () => {
    const r = aggregate([]);
    expect(r.totals.nonClosing).toBe(0);
    expect(r.totals.churn).toBe(0);
    expect(r.issueTree).toHaveLength(0);
    expect(r.priorityCounts).toEqual({ p1: 0, p2: 0, p3: 0 });
  });
});
