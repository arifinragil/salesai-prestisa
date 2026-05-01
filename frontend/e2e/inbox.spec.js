const { test, expect } = require('./fixtures');

test('inbox list loads after login', async ({ authedPage: page }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  // Either shows the empty-state OR at least one conversation row
  const hasContent = page.locator('text=/percakapan|Belum ada/');
  await expect(hasContent).toBeVisible();
});

test('navigate to first conversation if any', async ({ authedPage: page }) => {
  await page.goto('/inbox');
  const firstConv = page.locator('a[href^="/inbox/"]').first();
  const count = await firstConv.count();
  test.skip(count === 0, 'no conversations to click into');

  await firstConv.click();
  await expect(page).toHaveURL(/\/inbox\/\d+/);
  await expect(page.getByText(/Kembali ke inbox/)).toBeVisible();
});
