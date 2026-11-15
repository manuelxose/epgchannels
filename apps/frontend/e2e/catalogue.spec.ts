import { expect, test } from '@playwright/test';
import { searchFor, stubData, waitForCatalogue } from './helpers';

test.describe('Catálogo', () => {
  test.beforeEach(async ({ page }) => {
    await stubData(page);
    await page.goto('/television');
  });

  test('carga el catálogo con contador y tiles', async ({ page }) => {
    await waitForCatalogue(page);
    const summary = page.getByTestId('catalogue-summary');
    await expect(summary).toHaveText('Mostrando 1–8 de 8 canales');
    await expect(page.locator('app-channel-tile')).toHaveCount(8);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Televisión en directo');
  });

  test('la búsqueda ignora acentos y mayúsculas', async ({ page }) => {
    await waitForCatalogue(page);
    await searchFor(page, 'SENAL');
    await expect(page.getByTestId('catalogue-summary')).toHaveText('1 resultado');
    await expect(page.locator('app-channel-tile')).toHaveCount(1);
    await expect(page.locator('app-channel-tile')).toContainText('Señal Rota');
  });

  test('la búsqueda sin resultados muestra el estado vacío con acción', async ({ page }) => {
    await waitForCatalogue(page);
    await searchFor(page, 'zzzz');
    await expect(page.getByTestId('catalogue-empty-search')).toBeVisible();
    await expect(page.getByTestId('catalogue-empty-search')).toContainText('Ningún canal coincide');
    await expect(page.getByTestId('catalogue-summary')).toHaveText('0 resultados');
    await page.getByTestId('clear-search').click();
    await expect(page.getByTestId('catalogue-summary')).toHaveText('Mostrando 1–8 de 8 canales');
  });

  test('el filtro por categoría reduce el catálogo', async ({ page }) => {
    await waitForCatalogue(page);
    const select = page.getByLabel('Filtrar por categoría');
    await expect(select.locator('optgroup')).toHaveCount(2);
    const options = await select.locator('option').allTextContents();
    expect(options.some((label) => label.includes('Generalistas'))).toBe(true);
    await select.selectOption({ label: 'Generalistas (7)' });
    await expect(page.locator('app-channel-tile')).toHaveCount(7);
    await expect(page.getByTestId('catalogue-summary')).toHaveText('7 resultados');
  });

  test('el filtro por disponibilidad separa estados de reproducción', async ({ page }) => {
    await waitForCatalogue(page);
    const select = page.getByLabel('Filtrar por disponibilidad');
    await select.selectOption('external');
    await expect(page.locator('app-channel-tile')).toHaveCount(1);
    await expect(page.locator('app-channel-tile')).toContainText('Solo Externo');
    await select.selectOption('no-emission');
    await expect(page.locator('app-channel-tile')).toContainText('Sin Emisión');
  });

  test('los favoritos se marcan, filtran y persisten al recargar', async ({ page }) => {
    await waitForCatalogue(page);
    const favoriteButton = page.getByRole('button', { name: 'Añadir La Dos de favoritos' });
    await favoriteButton.click();
    await expect(page.getByRole('button', { name: 'Quitar La Dos de favoritos' })).toBeVisible();

    await page.getByRole('button', { name: 'Mostrar solo favoritos' }).click();
    await expect(page.locator('app-channel-tile')).toHaveCount(1);
    await expect(page.locator('app-channel-tile')).toContainText('La Dos');

    await page.reload();
    await waitForCatalogue(page);
    await page.getByRole('button', { name: 'Mostrar solo favoritos' }).click();
    await expect(page.locator('app-channel-tile')).toHaveCount(1);
    await expect(page.locator('app-channel-tile')).toContainText('La Dos');
  });

  test('favoritos vacíos explican la siguiente acción', async ({ page }) => {
    await waitForCatalogue(page);
    const toggle = page.getByRole('button', { name: 'Mostrar solo favoritos' });
    await expect(toggle).toBeDisabled();
    await expect(page.locator('app-channel-tile')).toHaveCount(8);
  });

  test('mantiene el catálogo usando los datos de demostración si la fuente falla', async ({ page }) => {
    await page.unrouteAll();
    await stubData(page, { failCatalog: true, failEpg: true });
    await page.goto('/television');
    await expect(page.getByText('Catálogo de demostración', { exact: false })).toBeVisible();
    await expect(page.locator('app-channel-tile').first()).toBeVisible();
  });
});
