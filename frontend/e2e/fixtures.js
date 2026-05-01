const { test: base, expect } = require('@playwright/test');

const ADMIN_USER = process.env.E2E_USER || 'finance';
const ADMIN_PASS = process.env.E2E_PASS;

if (!ADMIN_PASS) {
  console.warn('[playwright] E2E_PASS not set — login tests will fail. Export E2E_PASS=<password> before running.');
}

const test = base.extend({
  // Authenticated page fixture: logs in once via API and reuses cookie
  authedPage: async ({ page, context, baseURL }, use) => {
    const r = await page.request.post('/api/auth/login', {
      data: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    if (!r.ok()) {
      throw new Error(`Pre-login failed: ${r.status()} ${await r.text()}`);
    }
    await use(page);
  },
});

module.exports = { test, expect, ADMIN_USER };
