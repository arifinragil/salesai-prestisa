const { test, expect, ADMIN_USER } = require('./fixtures');

test('happy login redirects to /inbox', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Tiara Admin' })).toBeVisible();

  await page.getByLabel('Username').fill(ADMIN_USER);
  await page.getByLabel('Password').fill(process.env.E2E_PASS || '');
  await page.getByRole('button', { name: 'Login' }).click();

  await page.waitForURL(/\/inbox/, { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
});

test('bad password shows error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill(ADMIN_USER);
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Login' }).click();

  await expect(page.getByText(/Password salah|Akun tidak valid/)).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/login/);
});

test('/inbox without auth redirects to /login', async ({ browser }) => {
  // Fresh context = no cookies
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});
