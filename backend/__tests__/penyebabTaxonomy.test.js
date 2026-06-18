'use strict';
const T = require('../services/penyebabTaxonomy');

describe('penyebabTaxonomy', () => {
  test('has 6 top issues', () => {
    expect(Object.keys(T.ISSUE_TREE_DETAIL).length).toBe(6);
  });

  test('normalizeIssueTag accepts a known triple', () => {
    const issue = Object.keys(T.ISSUE_TREE_DETAIL)[0];
    const sub = Object.keys(T.ISSUE_TREE_DETAIL[issue])[0];
    const rinci = T.ISSUE_TREE_DETAIL[issue][sub][0];
    const out = T.normalizeIssueTag({ issue, sub_issue: sub, rinci, detail: 'test' });
    expect(out).not.toBeNull();
    expect(out.issue).toBe(issue);
    expect(out.sub_issue).toBe(sub);
  });

  test('normalizeIssueTag rejects an unknown issue', () => {
    const out = T.normalizeIssueTag({ issue: 'Nonsense Issue', sub_issue: 'x', rinci: 'y', detail: '' });
    expect(out).toBeNull();
  });

  test('extractJson parses a fenced json blob', () => {
    expect(T.extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('ISSUES is an array of the 6 issue names', () => {
    expect(Array.isArray(T.ISSUES)).toBe(true);
    expect(T.ISSUES.length).toBe(6);
    expect(T.ISSUES[0]).toBe(Object.keys(T.ISSUE_TREE_DETAIL)[0]);
  });

  test('bucket classifies root cause text', () => {
    expect(T.bucket('harga terlalu mahal', T.ROOT_CAUSE_THEMES)).toBe('Harga & budget');
    expect(T.bucket('', T.ROOT_CAUSE_THEMES)).toBe('Lainnya');
  });
});
