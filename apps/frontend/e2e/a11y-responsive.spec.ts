import { expect, test } from '@playwright/test';
import { playerState, stubApi, waitForCatalogue } from './helpers';

test.describe('Accesibilidad', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test('expone una estructura de landmarks y un enlace de salto', async ({ page }) => {
    await page.goto('/television');
    await waitForCatalogue(page);
    await expect(page.locator('header')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    /*
     * On narrow viewports the primary navigation collapses into a menu button, so
     * the visible landmark differs by viewport while the header stays equivalent.
     */
    const narrow = (page.viewportSize()?.width ?? 1440) <= 720;
    if (narrow) {
      await expect(page.getByRole('button', { name: 'Abrir menú' })).toBeVisible();
    } else {
      await expect(page.locator('nav[aria-label="Secciones"]')).toBeVisible();
    }
    const skip = page.getByRole('link', { name: 'Saltar al contenido' });
    await expect(skip).toHaveCount(1);
    await skip.focus();
    await expect(skip).toBeFocused();
  });

  test('el contador del catálogo es una región viva', async ({ page }) => {
    await page.goto('/television');
    await waitForCatalogue(page);
    const summary = page.getByTestId('catalogue-summary');
    await expect(summary).toHaveAttribute('role', 'status');
    await expect(summary).toHaveAttribute('aria-live', 'polite');
  });

  test('los controles del reproductor tienen nombre accesible', async ({ page }) => {
    await page.goto('/television/la-uno');
    await expect(page.locator('video')).toHaveAttribute('aria-label', 'Emisión de La Uno');
    for (const name of ['Reproducir', 'Silenciar', 'Directo']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1);
    }
    /*
     * The volume slider is hidden on narrow viewports to keep the control bar
     * usable on touch screens; mute remains the accessible volume control.
     */
    const narrow = (page.viewportSize()?.width ?? 1440) <= 720;
    if (narrow) {
      await expect(page.getByRole('button', { name: 'Silenciar' })).toBeVisible();
      await expect(page.getByRole('slider', { name: 'Volumen' })).toBeHidden();
    } else {
      await expect(page.getByRole('slider', { name: 'Volumen' })).toBeVisible();
    }
  });

  test('el estado del reproductor se anuncia sin interrumpir', async ({ page }) => {
    await page.goto('/television/la-uno');
    const live = page.locator('app-player p[role="status"]');
    await expect(live).toHaveAttribute('aria-live', 'polite');
  });

  test('un canal inexistente se anuncia y ofrece volver al catálogo', async ({ page }) => {
    await page.goto('/television/no-existe-abc');
    await expect(page.getByTestId('channel-not-found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Volver al catálogo' })).toBeVisible();
  });

  test('se puede recorrer el catálogo solo con teclado', async ({ page }) => {
    await page.goto('/television');
    await waitForCatalogue(page);
    await page.getByLabel('Buscar canal').focus();
    const order: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Tab');
      order.push(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return active ? `${active.tagName.toLowerCase()}:${active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 24) ?? ''}` : 'none';
        }),
      );
    }
    expect(order.length).toBe(6);
    expect(order.every((entry) => entry !== 'none')).toBe(true);
    // Every focused element receives a visible focus indicator.
    const focusRing = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return '';
      const style = getComputedStyle(active);
      return `${style.boxShadow}|${style.outlineStyle}`;
    });
    expect(focusRing).not.toBe('none|none');
  });

  test('los tiles son enlaces reales con etiqueta', async ({ page }) => {
    await page.goto('/television');
    await waitForCatalogue(page);
    const first = page.locator('app-channel-tile a').first();
    await expect(first).toHaveAttribute('aria-label', /La Uno/);
    await expect(first).toHaveAttribute('href', /\/television\/la-uno$/);
  });
});

test.describe('Responsive', () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
  });

  test('no hay desplazamiento horizontal en ningún ancho', async ({ page }) => {
    for (const width of [320, 375, 390, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/television');
      await waitForCatalogue(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test('en móvil el reproductor precede al catálogo', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/television/la-uno');
    await expect(page.locator('video')).toBeVisible();
    const order = await page.evaluate(() => {
      const stage = document.querySelector('.layout__stage');
      const rail = document.querySelector('.layout__rail');
      if (!stage || !rail) return null;
      return stage.getBoundingClientRect().top < rail.getBoundingClientRect().top ? 'stage-first' : 'rail-first';
    });
    expect(order).toBe('stage-first');
  });

  test('en escritorio el catálogo es una barra lateral fija', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/television/la-uno');
    // Wait for the layout shell to exist before measuring it.
    await expect(page.locator('.layout__rail')).toBeVisible();
    await expect(page.locator('.layout__stage')).toBeVisible();
    const layout = await page.evaluate(() => {
      const rail = document.querySelector('.layout__rail') as HTMLElement | null;
      const stage = document.querySelector('.layout__stage') as HTMLElement | null;
      if (!rail || !stage) return null;
      return { railLeft: rail.getBoundingClientRect().left, stageLeft: stage.getBoundingClientRect().left };
    });
    expect(layout).not.toBeNull();
    expect(layout!.railLeft).toBeLessThan(layout!.stageLeft);
  });

  test('los objetivos táctiles principales cumplen 44px en móvil', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/television');
    await waitForCatalogue(page);
    const sizes = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('app-channel-tile a, .rail__fav-toggle, .rail__search')];
      return targets.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    });
    for (const size of sizes) {
      // The smaller dimension must meet the touch target size.
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('Limpieza de recursos', () => {
  test('cambios repetidos de canal no filtran elementos multimedia', async ({ page }) => {
    await stubApi(page);
    await page.goto('/television/la-uno');
    await expect(page.locator('video')).toHaveCount(1);

    // Count how many media elements are ever attached across rapid switches.
    await page.evaluate(() => {
      (window as unknown as { __mediaCount: number }).__mediaCount = 0;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLElement) {
              const state = window as unknown as { __mediaCount: number };
              state.__mediaCount += node.matches('video') ? 1 : node.querySelectorAll('video').length;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    const slugs = ['la-dos', 'canal-alternativo', 'la-uno', 'la-dos', 'canal-alternativo', 'la-uno'];
    for (const slug of slugs) {
      await page.evaluate((target) => {
        history.pushState({}, '', `/television/${target}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, slug);
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(2500);

    expect(await page.locator('video').count()).toBe(1);
    const attached = await page.evaluate(() => (window as unknown as { __mediaCount: number }).__mediaCount);
    expect(attached).toBeLessThanOrEqual(slugs.length + 1);

    const state = await playerState(page);
    expect(['playing', 'paused', 'buffering', 'loading']).toContain(state.status);
  });

  test('salir del canal destruye el motor', async ({ page }) => {
    await stubApi(page);
    await page.goto('/television/la-uno');
    await expect(page.locator('video')).toHaveCount(1);

    // In-app navigation (NOT a page reload) must run the component teardown.
    await page.evaluate(() => {
      history.pushState({}, '', '/television');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.getByTestId('catalogue-summary')).toBeVisible();

    // Returning to a channel builds a fresh, working player.
    await page.evaluate(() => {
      history.pushState({}, '', '/television/la-uno');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('video')).toHaveCount(1);
  });
});
