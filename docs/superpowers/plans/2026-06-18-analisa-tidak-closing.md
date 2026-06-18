# Analisa Tidak Closing — Implementation Plan

**Goal:** A CRM menu `/analisa-tidak-closing` that classifies non-closing WA leads into the 6-issue taxonomy (from the Google Sheet) using our own AI pipeline, channel-wide, and renders the ads `/penyebab` Issue-Tree UI.

**Decisions (approved):** own pipeline (all WA leads, not ads-only); Gemini 2.5 Flash; taxonomy from sheet; new table `crm_lead_penyebab`; replicate ads `/penyebab` UI.

**PORT FROM (ads app on this VPS — read these, adapt to our DBs):**
- Taxonomy + prompt + normalizeIssueTag: `/home/krttpt/ads/lib/leadAnalysis.ts` (`ISSUE_TREE_DETAIL`, `STRUCTURED_ANALYSIS_INSTRUCTION`, `normalizeIssueTag`, `extractJson`, theme buckets).
- Aggregation shape: `/home/krttpt/ads/app/api/leads/penyebab-analysis/route.ts` + `/home/krttpt/ads/lib/db.ts` `fetchPenyebabAnalysisImpl`.
- UI: `/home/krttpt/ads/components/dashboard/PenyebabAnalysis.tsx` (KPI strip, 4-level Issue Tree accordion, Sales POV cards, Rekomendasi bar, Sebaran table). Colors: Produk #0d9488, Harga/Promo/Payment #dc2626, Customer #9333ea, Sales Handling #f97316, Kualitas Lead #0284c7, Mitra #d97706.

**OUR data model:** `db/postgres` = vonage_reports (crm_*). `db/lotus` = read-only contacts/messages (two DBs, no JOIN; messages.direction = inbound/outbound; human-staff outbound = cs_id IS NOT NULL; use TZ-corrected received_at). Diagnosis transcript builder + GEMINI_API_KEY pattern: see `backend/cron_analyst_tier_a_prewarm.js`. Gemini client: `backend/services/geminiClient.js` (model gemini-2.5-flash).

**Non-closing candidate definition:** crm_lotus_state leads with status NOT IN ('closed','won'), last activity within the analysis window, inbound_count >= 4 (reuse the candidate query from cron_analyst_tier_a_prewarm.js). The AI returns is_closing; aggregation filters is_closing=false.

---

## Phase 1 — Taxonomy + migration

### Task 1: `backend/services/penyebabTaxonomy.js`
Port `ISSUE_TREE_DETAIL` (6 issues → 27 subs → rinci leaves), `normalizeIssueTag(issue, sub, rinci)` (validate against taxonomy, snap rinci case-insensitive, reject unknown), and the theme-bucket constants from `/home/krttpt/ads/lib/leadAnalysis.ts` VERBATIM (copy the data, it's the source of truth = the sheet). Export them. Add `backend/__tests__/penyebabTaxonomy.test.js`: normalizeIssueTag accepts a known triple, rejects an unknown issue, snaps a lowercased rinci. TDD.

### Task 2: migration `039_lead_penyebab.sql`
```sql
CREATE TABLE IF NOT EXISTS crm_lead_penyebab (
  id BIGSERIAL PRIMARY KEY,
  lotus_id TEXT UNIQUE NOT NULL,
  cust_number TEXT, business_number TEXT,
  is_closing BOOLEAN, churn BOOLEAN,
  issue TEXT, sub_issue TEXT, rinci TEXT,
  penyebab_tidak_closing TEXT,
  analisa JSONB,                 -- {five_why, pov_customer, pov_sales:{good[],problem[]}, actions:[{text,priority,deadline}], risk_assessment}
  ai_model TEXT, ai_tokens_in INT, ai_tokens_out INT,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_penyebab_issue ON crm_lead_penyebab (issue, sub_issue);
CREATE INDEX IF NOT EXISTS idx_penyebab_analyzed ON crm_lead_penyebab (analyzed_at DESC);
```
Apply via `npm run migrate` (fallback psql).

## Phase 2 — Analyze service + cron + on-demand

### Task 3: `backend/services/penyebabAnalyze.js`
`analyzeLead(lotus_id)`: resolve cust_number from lotus contacts; build transcript from lotus messages (same builder shape as cron_analyst_tier_a_prewarm.js, oldest→newest, cap ~40 msgs, slice 500 char, label Customer/Sales/AI Bot); call Gemini 2.5 Flash (geminiClient or GoogleGenerativeAI directly like analystReport.js) with system+user = ported `STRUCTURED_ANALYSIS_INSTRUCTION` (responseMimeType json). Parse with ported `extractJson`. Validate issue/sub/rinci via `normalizeIssueTag`. Upsert into crm_lead_penyebab (ON CONFLICT (lotus_id) DO UPDATE). Return the row. churn = /churn/i.test(analisa.risk_assessment). Unit-test the pure parts (extractJson + mapping) where feasible.

### Task 4: routes + cron
- Add `backend/routes/penyebab.js` mounted at `/api/penyebab` (requireStaff; aggregate GET is for the page, POST analyze is admin). Endpoints:
  - `POST /:lotus_id/analyze` (admin) → analyzeLead.
  - `POST /bulk-analyze` (admin) { lotus_ids[] } max 100, 200ms delay.
  - `GET /analysis?from&to&business&city&product` → aggregate (Task 5).
- Mount in `backend/index.js`.
- `backend/cron_penyebab_analyze.js`: select non-closing candidates (per definition above) not already in crm_lead_penyebab (or stale), run analyzeLead with concurrency ~4 + sleep, safety cap 1000. Add to pm2 ecosystem (cron) like crm-analyst-prewarm.

## Phase 3 — Aggregate API

### Task 5: `GET /api/penyebab/analysis`
Read crm_lead_penyebab joined with lotus contacts (for city/product/phone) over [from,to] (analyzed_at or lead date). Build the EXACT response shape the ads route returns (port `fetchPenyebabAnalysisImpl` logic, adapt SQL to crm_lead_penyebab):
```
{ totals:{nonClosing,churn,structuredCount,taggedCount},
  issueTree:[{issue,count,subs:[{subIssue,count,rinci:[{rinci,count,leads:[{phone,detail}]}]}]}],
  penyebabDist:[{category,count}], salesStrengths:[{theme,count}], salesProblems:[{theme,count}],
  actionThemes:[{theme,count}], priorityCounts:{p1,p2,p3}, availableCities:[], availableProducts:[] }
```
nonClosing = count is_closing=false; taggedCount = count with issue not null. Pure aggregation helper `backend/services/penyebabAggregate.js` + unit test (buildIssueTree from rows).

## Phase 4 — Frontend

### Task 6: page + components
- `frontend/src/pages/analisa-tidak-closing.js` + components under `frontend/src/components/penyebab/` porting `PenyebabAnalysis.tsx` to our stack (Pages Router, JS not TS, our `Layout`, SWR `fetcher`, `api`). Use recharts if already a dep (check frontend/package.json; else render bars with divs). Sections: KPI strip (3 cards), Issue Tree 4-level collapsible accordion (issue→sub→rinci→leads with a "Buka chat" link → `/lotus-inbox/[lotus_id]` instead of ads ChatDrawer), Sales POV (Kekuatan/Masalah), Rekomendasi bar + P1/P2/P3, Sebaran table. Date range filter (default last 30d). Issue colors as above.
- Add nav item to `frontend/src/lib/menuCatalog.js`: `{ href:'/analisa-tidak-closing', label:'Analisa Closing', icon:'🔬', adminOnly:true }`.

## Phase 5 — deploy + verify
- `npm run migrate`; pm2 restart backend+frontend; build frontend; smoke endpoints (401 wired); analyze a few real leads via bulk-analyze and confirm rows + the page renders an Issue Tree. Deploy to pilot.

## Acceptance
- Taxonomy matches the sheet (normalizeIssueTag rejects unknowns).
- analyzeLead stores a validated issue/sub/rinci + analisa JSON for a real lead.
- /api/penyebab/analysis returns the Issue-Tree shape; page renders KPI + tree + POV + table.
- Cron analyzes non-closing candidates channel-wide.
- Nav gated; page admin-only.
