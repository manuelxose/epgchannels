import { expect, test } from '@playwright/test';
import { stubData, waitForCatalogue } from './helpers';

test.describe('EPG y navegación', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page);
  });

  test('muestra programa actual, siguiente y después con horarios locales', async ({ page }) => {
    await page.goto('/television/la-uno');
    const panel = page.locator('app-programme-panel');
    await expect(panel).toContainText('Programa en directo');
    await expect(panel).toContainText('Siguiente');
    await expect(panel).toContainText('Programa tardío');
    // Times render as HH:mm – HH:mm in the browser locale.
    await expect(panel.locator('.tabular').first()).toHaveText(/^\d{2}:\d{2} – \d{2}:\d{2}$/);
  });

  test('abre y cierra la parrilla completa del canal', async ({ page }) => {
    await page.goto('/television/la-uno');
    await page.getByRole('button', { name: 'Toda la programación' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Programa en directo');
    await expect(dialog).toContainText('Programa tardío');
    await page.getByRole('button', { name: 'Cerrar' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('un canal sin guía lo indica sin romper la página', async ({ page }) => {
    await page.goto('/television/sin-guia');
    await expect(page.locator('app-programme-panel')).toContainText('Programación no disponible para este canal');
  });

  test('la parrilla global lista canales con programación', async ({ page }) => {
    await page.goto('/schedule');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Parrilla de programación');
    const rows = page.locator('.row');
    await expect(rows.first()).toBeVisible();
    await expect(page.locator('.schedule')).toContainText('Programa en directo');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    await expect(page.locator('.row').filter({ hasText: 'Sin Guía' })).toHaveCount(0);

    // Filtering narrows to matching channels only.
    await page.getByLabel('Buscar canal en la parrilla').fill('europe');
    await expect(page.locator('.row')).toHaveCount(1);
    await expect(page.locator('.row').first()).toContainText('Europe News');
    await page.getByLabel('Buscar canal en la parrilla').fill('zzzz');
    await expect(page.locator('.row')).toHaveCount(0);
  });

  test('la navegación por URL directa carga el canal correcto', async ({ page }) => {
    await page.goto('/television/canal-alternativo');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Canal Alternativo');
    await expect(page).toHaveTitle('Canal Alternativo en directo · TDT Player');
    // The active tile is marked for assistive technology.
    await expect(page.locator('app-channel-tile a[aria-current="page"]')).toContainText('Canal Alternativo');
  });

  test('el historial del navegador restaura el canal anterior', async ({ page }) => {
    await page.goto('/television/la-uno');
    await page.locator('app-channel-tile a').filter({ hasText: 'La Dos' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('La Dos');
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('La Uno');
  });

  test('el tema cambia y persiste entre visitas', async ({ page }) => {
    await page.goto('/television');
    await waitForCatalogue(page);
    const initial = await page.evaluate(() => document.documentElement.dataset.theme);

    /*
     * The header button and the (mobile-only) menu entry share the same
     * accessible name. Target the header one explicitly: it is the always-visible
     * control. `.first()` resolves the duplicate-name ambiguity deterministically.
     */
    await page.getByRole('button', { name: /Activar modo/ }).first().click();
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
      .not.toBe(initial);

    const changed = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.reload();
    await waitForCatalogue(page);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(changed);
  });
});
