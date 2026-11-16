/**
 * Shared E2E helpers.
 *
 * The fixtures below serve **our own API** (same endpoints, envelopes and error
 * shapes as the real backend), so a failure is attributable to our code rather
 * than to an emitter. Media is never stubbed: the bundled HLS files are fetched
 * over real HTTP, so the engines are exercised for real.
 *
 * `e2e/real-backend.spec.ts` does the opposite on purpose: it stubs nothing and
 * runs against the live API and database.
 */
import { expect, type Page } from '@playwright/test';
import { DEFAULT_CHANNELS, installApiFixtures, type FixtureChannel, type FixtureOptions } from './api-fixtures';

export { DEFAULT_CHANNELS };
export type { FixtureChannel, FixtureOptions };

/** Installs the API fixtures for a page. */
export async function stubApi(page: Page, options: FixtureOptions = {}): Promise<void> {
  await installApiFixtures(page, options);
}

/** Waits until the catalogue has rendered and reports its count. */
export async function waitForCatalogue(page: Page): Promise<void> {
  await expect(page.getByTestId('catalogue-summary')).not.toHaveText(/Cargando/i);
  await expect(page.locator('app-channel-tile').first()).toBeVisible();
}

export async function searchFor(page: Page, text: string): Promise<void> {
  const input = page.getByLabel('Buscar canal');
  await input.fill(text);
}

/** Reads the player state probe exposed by the player component. */
export async function playerState(page: Page): Promise<{ status: string; engine: string | null }> {
  const probe = page.getByTestId('player-state');
  return {
    status: (await probe.textContent())?.trim() ?? '',
    engine: await probe.getAttribute('data-engine'),
  };
}

/** Waits until the video element is actually decoding frames. */
export async function waitForFrames(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video');
      return !!video && video.readyState >= 2 && video.videoWidth > 0;
    },
    undefined,
    { timeout },
  );
}
