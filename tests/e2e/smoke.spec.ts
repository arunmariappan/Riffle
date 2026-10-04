import { expect, test } from '@playwright/test';
import { imageSpread, waitForReady } from './helpers';

test('renders and reads back a WebGPU frame (Phase 0)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?scene=test&autostart=1&quality=high');
  await waitForReady(page);
  await page.waitForTimeout(2500);
  const png = await page.getByTestId('viewport').screenshot();
  expect(imageSpread(png)).toBeGreaterThan(25);
  expect(errors).toEqual([]);
});

test('shows the friendly page when WebGPU is missing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Riffle needs WebGPU' })).toBeVisible();
  await expect(page.getByText('Google Chrome')).toBeVisible();
});
