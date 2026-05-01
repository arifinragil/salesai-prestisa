const { test, expect } = require('./fixtures');

test('monitor dashboard shows core stats', async ({ authedPage: page }) => {
  await page.goto('/ai-monitor');
  await expect(page.getByRole('heading', { name: /Monitor hari ini/ })).toBeVisible({ timeout: 10_000 });
  // StatCard labels are rendered with `uppercase` CSS but DOM text remains case as written.
  // Match flexibly to handle either case.
  await expect(page.getByText(/^Inbound$/i).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^AI sent$/i).first()).toBeVisible();
  await expect(page.getByText(/^Cost hari ini$/i).first()).toBeVisible();
});

test('settings page shows persona list', async ({ authedPage: page }) => {
  await page.goto('/ai-settings');
  await expect(page.getByRole('heading', { name: /Persona & Settings/ })).toBeVisible();
  await expect(page.getByText('Persona versions')).toBeVisible();
  await expect(page.getByText(/tiara_v1/)).toBeVisible();
});
