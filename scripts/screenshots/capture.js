// Screenshot capture script for Tiara CRM manual book.
// Usage: TIARA_USER=... TIARA_PASS=... node capture.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.TIARA_BASE || 'https://salesai.prestisa.net';
const USER = process.env.TIARA_USER;
const PASS = process.env.TIARA_PASS;
const OUT_DIR = path.resolve(__dirname, '../../docs/assets/screenshots');

if (!USER || !PASS) {
  console.error('TIARA_USER and TIARA_PASS env vars required');
  process.exit(1);
}

const SHOTS = [
  // [page-path, output-filename, options]
  ['/inbox', '01-inbox-list.png', {}],
  ['/pipeline', '02-pipeline-board.png', {}],
  ['/ai-monitor', '03-ai-monitor.png', { fullPage: true }],
  ['/ai-settings', '04-ai-settings.png', { fullPage: true }],
  ['/knowledge', '05-knowledge.png', {}],
  ['/reply-templates', '06-reply-templates.png', {}],
  ['/tags', '07-tags.png', {}],
  ['/promos', '08-promos.png', {}],
  ['/snippets', '09-snippets.png', {}],
  ['/users', '10-users.png', {}],
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,  // retina-quality
  });
  const page = await ctx.newPage();

  // Login
  console.log('[login] navigating to /login');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], input[type="text"]:not([type="hidden"])', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  console.log('[login] OK, current URL:', page.url());

  // Iterate pages
  for (const [pageUrl, filename, opts] of SHOTS) {
    const fullUrl = `${BASE}${pageUrl}`;
    console.log(`[shot] ${pageUrl} → ${filename}`);
    try {
      await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(1500);  // let SWR settle
      await page.screenshot({
        path: path.join(OUT_DIR, filename),
        fullPage: opts.fullPage || false,
      });
    } catch (err) {
      console.warn(`[shot] FAILED ${pageUrl}:`, err.message);
    }
  }

  // Inbox detail (first conv)
  try {
    await page.goto(`${BASE}/inbox`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const firstLink = await page.$('a[href^="/inbox/"]');
    if (firstLink) {
      const href = await firstLink.getAttribute('href');
      console.log(`[shot] /inbox/[id] via ${href}`);
      await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      await page.screenshot({
        path: path.join(OUT_DIR, '11-inbox-detail.png'),
        fullPage: false,
      });
    }
  } catch (err) {
    console.warn('[shot] inbox detail FAILED:', err.message);
  }

  // Mobile views (key pages)
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const mPage = await mobileCtx.newPage();
  await mPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await mPage.fill('input[name="username"], input[type="text"]:not([type="hidden"])', USER);
  await mPage.fill('input[type="password"]', PASS);
  await mPage.click('button[type="submit"]');
  await mPage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });

  for (const [url, filename] of [
    ['/inbox', 'mobile-01-inbox.png'],
    ['/pipeline', 'mobile-02-pipeline.png'],
  ]) {
    try {
      console.log(`[mobile] ${url} → ${filename}`);
      await mPage.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
      await mPage.waitForTimeout(1500);
      await mPage.screenshot({ path: path.join(OUT_DIR, filename), fullPage: false });
    } catch (err) {
      console.warn(`[mobile] FAILED ${url}:`, err.message);
    }
  }

  await browser.close();
  console.log(`[done] screenshots saved to ${OUT_DIR}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
