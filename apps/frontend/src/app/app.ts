import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { IconComponent } from './shared/ui/icon.component';
import { PreferencesStore } from './core/state/preferences.store';

const THEME_COLOR: Readonly<Record<'dark' | 'light', string>> = {
  dark: '#0a0e17',
  light: '#eef1f7',
};

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly preferences = inject(PreferencesStore);
  protected readonly mobileMenuOpen = signal(false);
  protected readonly systemPrefersLight = signal(
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches,
  );

  protected readonly isDark = computed(() => {
    const theme = this.preferences.theme();
    return theme === 'system' ? !this.systemPrefersLight() : theme === 'dark';
  });
  protected readonly themeIcon = computed(() => (this.isDark() ? 'moon' : 'sun'));
  protected readonly themeLabel = computed(() => (this.isDark() ? 'Activar modo claro' : 'Activar modo oscuro'));

  constructor() {
    // Keep the document theme in sync with the preference (and with system changes).
    effect(() => {
      const resolved = this.isDark() ? 'dark' : 'light';
      document.documentElement.dataset['theme'] = resolved;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
    });

    if (typeof matchMedia === 'function') {
      const query = matchMedia('(prefers-color-scheme: light)');
      query.addEventListener('change', (event) => this.systemPrefersLight.set(event.matches));
    }
  }

  protected toggleTheme(): void {
    this.preferences.setTheme(this.isDark() ? 'light' : 'dark');
  }

  protected toggleMenu(): void {
    this.mobileMenuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.mobileMenuOpen.set(false);
  }
}
