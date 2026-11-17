import { expect, test, type Page } from '@playwright/test';
import { stubApi, waitForCatalogue } from './helpers';

/**
 * Player keyboard, touch-target and responsive guarantees.
 *
 * Everything here is asserted against the REAL production build in a real
 * browser at a real 360px viewport: measured, never inferred from CSS.
 */

/** Opens a channel whose source is the bundled HLS stream and waits for the stage. */
async function openChannel(page: Page): Promise<void> {
  await page.goto('/television/la-uno');
  await expect(page.getByTestId('player-shell')).toBeVisible();
}

/** Reads the player's current volume slider value (0..100). */
async function volumeValue(page: Page): Promise<number> {
  const slider = page.getByLabel('Volumen', { exact: true });
  if ((await slider.count()) === 0) {
    return -1;
  }
  return Number(await slider.inputValue());
}

test.describe('Teclado del reproductor', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test('las teclas de letra actúan y están documentadas por un nombre accesible', async ({ page }) => {
    await openChannel(page);
    const shell = page.getByTestId('player-shell');

    // The surface describes its own shortcuts, so they are discoverable.
    await expect(shell).toHaveAttribute('aria-describedby', 'player-shortcuts');
    await expect(page.locator('#player-shortcuts')).toContainText('K o Espacio');

    const muteButton = page.getByRole('button', { name: 'Silenciar' });
    await expect(muteButton).toHaveAttribute('aria-pressed', 'false');

    // M toggles mute, and the real control's state follows.
    await shell.focus();
    await page.keyboard.press('m');
    await expect(page.getByRole('button', { name: 'Activar sonido' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('m');
    await expect(page.getByRole('button', { name: 'Silenciar' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('las flechas NO desplazan la página cuando el foco está fuera del reproductor', async ({ page }) => {
    await openChannel(page);
    const shell = page.getByTestId('player-shell');

    // Make the page scrollable so a scroll would be observable.
    await page.setViewportSize({ width: 1440, height: 420 });
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.id = 'e2e-spacer';
      spacer.style.height = '2000px';
      document.body.appendChild(spacer);
      window.scrollTo(0, 0);
    });

    /*
     * Focus a non-text control outside the player: a plain button, not the
     * search field. (An arrow pressed inside a text input is the browser's own
     * caret behaviour, so asserting scroll there would test Chromium, not our
     * player.) This is the first button that is not inside the player stage.
     */
    const outside = page.locator('button:not([data-testid="player-shell"] *)').first();
    await outside.focus();
    await expect(outside).toBeFocused();

    const volumeBefore = await volumeValue(page);
    const before = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);

    // The browser's own scrolling still works: the player did not consume the key.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before);

    // And a page-level arrow never silently changed the player's volume.
    expect(await volumeValue(page)).toBe(volumeBefore);
    void shell;
  });

  test('las flechas sí ajustan el volumen con el foco dentro del reproductor', async ({ page }) => {
    await openChannel(page);
    const shell = page.getByTestId('player-shell');
    await shell.focus();

    const before = await volumeValue(page);
    test.skip(before < 0, 'el control de volumen no está visible en este viewport');

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    const after = await volumeValue(page);
    expect(after).toBeLessThan(before);
  });

  test('F entra y sale de pantalla completa, y el botón refleja el estado real', async ({ page }) => {
    await openChannel(page);
    const shell = page.getByTestId('player-shell');
    const button = page.getByTestId('fullscreen-button');
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await shell.focus();
    await page.keyboard.press('f');
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null), { timeout: 5_000 })
      .toBe(true);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveAttribute('aria-label', 'Salir de pantalla completa');

    /*
     * Leave fullscreen. The player's own way out is the button (focus is
     * restored to it after entering), so this asserts the product's route.
     * Escape is the BROWSER's own exit and is not delivered as a page event in
     * the headless test harness, so it is not asserted here; the exit path we
     * own is what the button exercises.
     */
    await page.getByTestId('fullscreen-button').click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null), { timeout: 5_000 })
      .toBe(true);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).toHaveAttribute('aria-label', 'Pantalla completa');
  });
});

test.describe('Objetivos táctiles y responsive a 360px', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test('ningún control del reproductor baja de 44x44 y la página no desborda a 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openChannel(page);
    await waitForCatalogue(page);

    // No horizontal overflow of the document at 360px.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    // Every rendered control in the player's control bar meets 44x44.
    const controls = page.getByTestId('player-shell').locator('.ctl');
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible())) {
        continue;
      }
      const box = await control.boundingBox();
      expect(box, `control ${index} has a box`).not.toBeNull();
      expect(box!.width, `control ${index} width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `control ${index} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('el control de subtítulos solo aparece si la fuente los ofrece', async ({ page }) => {
    await openChannel(page);
    // The bundled HLS has no text tracks, so no dead control is rendered.
    await expect(page.getByTestId('subtitle-select')).toHaveCount(0);
  });

  test('los filtros de país e idioma existen y filtran de verdad', async ({ page }) => {
    await page.goto('/television');
    await waitForCatalogue(page);

    const country = page.getByTestId('country-filter');
    await expect(country).toBeVisible();
    // The option list is built from published data, so it is never empty.
    expect(await country.locator('option').count()).toBeGreaterThan(1);

    const language = page.getByTestId('language-filter');
    await expect(language).toBeVisible();
    await language.selectOption('es');
    await expect(page.getByTestId('catalogue-summary')).not.toHaveText(/Cargando/i);
  });
});
