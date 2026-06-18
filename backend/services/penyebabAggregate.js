'use strict';
/**
 * penyebabAggregate.js
 * Pure aggregation over crm_lead_penyebab rows.
 * No DB access — caller fetches rows, passes them here.
 *
 * Exports:
 *   aggregate(rows) → aggregated shape
 */

const {
  ISSUE_TREE_DETAIL,
  SALES_STRENGTH_THEMES,
  SALES_PROBLEM_THEMES,
  ACTION_THEMES,
  bucket,
} = require('./penyebabTaxonomy');

// Canonical issue order from taxonomy
const ISSUE_ORDER = Object.keys(ISSUE_TREE_DETAIL);

/**
 * @param {object[]} rows - crm_lead_penyebab rows (analisa may be object or JSON string)
 * @returns {object}
 */
function aggregate(rows) {
  // ── Totals ──────────────────────────────────────────────────────────────────
  const nonClosing = rows.filter(r => r.is_closing === false || r.is_closing == null).length;
  const churn = rows.filter(r => r.churn === true).length;
  const structuredCount = rows.filter(r => r.analisa != null).length;
  const taggedCount = rows.filter(r => r.issue != null).length;

  // ── Parse analisa safely ────────────────────────────────────────────────────
  function getAnalisa(r) {
    if (!r.analisa) return null;
    if (typeof r.analisa === 'object') return r.analisa;
    try { return JSON.parse(r.analisa); } catch { return null; }
  }

  // ── Issue Tree ───────────────────────────────────────────────────────────────
  // issueMap: issue → subMap: sub_issue → rinciMap: rinci → [{phone, detail}]
  const issueMap = new Map();

  for (const r of rows) {
    if (!r.issue) continue;
    const analisa = getAnalisa(r);
    const detail = analisa?.issue_tree?.detail ?? null;
    const phone = r.cust_number ?? null;

    if (!issueMap.has(r.issue)) issueMap.set(r.issue, new Map());
    const subMap = issueMap.get(r.issue);

    const subKey = r.sub_issue ?? '(unclassified)';
    if (!subMap.has(subKey)) subMap.set(subKey, new Map());
    const rinciMap = subMap.get(subKey);

    const rinciKey = r.rinci ?? '(unclassified)';
    if (!rinciMap.has(rinciKey)) rinciMap.set(rinciKey, []);
    rinciMap.get(rinciKey).push({ phone, detail });
  }

  // Build issueTree array ordered by ISSUE_ORDER, then by count desc within
  const issueTree = [];
  for (const issue of ISSUE_ORDER) {
    if (!issueMap.has(issue)) continue;
    const subMap = issueMap.get(issue);
    const subs = [];
    for (const [subIssue, rinciMap] of subMap) {
      const rinci = [];
      for (const [rinciVal, leads] of rinciMap) {
        rinci.push({ rinci: rinciVal, count: leads.length, leads });
      }
      rinci.sort((a, b) => b.count - a.count);
      subs.push({ subIssue, count: rinci.reduce((s, x) => s + x.count, 0), rinci });
    }
    subs.sort((a, b) => b.count - a.count);
    const issueCount = subs.reduce((s, x) => s + x.count, 0);
    issueTree.push({ issue, count: issueCount, subs });
  }
  issueTree.sort((a, b) => {
    // Primary: ISSUE_ORDER position
    return ISSUE_ORDER.indexOf(a.issue) - ISSUE_ORDER.indexOf(b.issue);
  });

  // ── penyebabDist (count by issue) ───────────────────────────────────────────
  const penyebabDist = issueTree.map(({ issue, count }) => ({ category: issue, count }));

  // ── Sales POV & action themes ───────────────────────────────────────────────
  const strengthBuckets = new Map();
  const problemBuckets = new Map();
  const actionBucketMap = new Map();
  const priorityCounts = { p1: 0, p2: 0, p3: 0 };

  for (const r of rows) {
    const analisa = getAnalisa(r);
    if (!analisa) continue;

    // pov_sales.good
    for (const item of (analisa.pov_sales?.good ?? [])) {
      if (!item) continue;
      const theme = bucket(item, SALES_STRENGTH_THEMES);
      strengthBuckets.set(theme, (strengthBuckets.get(theme) ?? 0) + 1);
    }

    // pov_sales.problem
    for (const item of (analisa.pov_sales?.problem ?? [])) {
      if (!item) continue;
      const theme = bucket(item, SALES_PROBLEM_THEMES);
      problemBuckets.set(theme, (problemBuckets.get(theme) ?? 0) + 1);
    }

    // action.next_actions
    for (const na of (analisa.action?.next_actions ?? [])) {
      if (!na) continue;
      if (na.action) {
        const theme = bucket(na.action, ACTION_THEMES);
        actionBucketMap.set(theme, (actionBucketMap.get(theme) ?? 0) + 1);
      }
      const pri = String(na.priority ?? '').toUpperCase();
      if (pri === 'P1') priorityCounts.p1++;
      else if (pri === 'P2') priorityCounts.p2++;
      else if (pri === 'P3') priorityCounts.p3++;
    }
  }

  function mapToSorted(m) {
    return [...m.entries()]
      .map(([theme, count]) => ({ theme, count }))
      .sort((a, b) => b.count - a.count);
  }

  return {
    totals: { nonClosing, churn, structuredCount, taggedCount },
    issueTree,
    penyebabDist,
    salesStrengths: mapToSorted(strengthBuckets),
    salesProblems: mapToSorted(problemBuckets),
    actionThemes: mapToSorted(actionBucketMap),
    priorityCounts,
  };
}

module.exports = { aggregate };
