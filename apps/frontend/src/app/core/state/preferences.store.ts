import { Injectable, computed, signal } from '@angular/core';
import { SafeStorage, browserStorage, readJson, writeJson } from './safe-storage';

export type ThemePreference = 'dark' | 'light' | 'system';

const THEME_KEY = 'tdtpref.theme';
const FAVORITES_KEY = 'tdtpref.favorites';
const RECENT_KEY = 'tdtpref.lastChannels';
const VOLUME_KEY = 'tdtpref.volume';
const SOURCE_KEY = 'tdtpref.sourceIndex';

const MAX_RECENT = 8;

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asTheme(value: unknown): ThemePreference | undefined {
  return value === 'dark' || value === 'light' || value === 'system' ? value : undefined;
}

function asVolume(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

function asIndexMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * User preferences: theme, favourites, recent channels, remembered volume and
 * per-channel source selection. All state is signal-based so the zoneless
 * change detector sees every update.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesStore {
  private readonly storage = new SafeStorage(browserStorage());

  private readonly favoriteIdsState = signal<ReadonlySet<string>>(
    new Set(readJson(this.storage, FAVORITES_KEY, asStringArray) ?? []),
  );
  private readonly recentIdsState = signal<readonly string[]>(
    readJson(this.storage, RECENT_KEY, asStringArray) ?? [],
  );
  private readonly themeState = signal<ThemePreference>(readJson(this.storage, THEME_KEY, asTheme) ?? 'dark');
  private readonly volumeState = signal<number>(readJson(this.storage, VOLUME_KEY, asVolume) ?? 0.8);
  private readonly sourceIndexState = signal<Record<string, number>>(
    readJson(this.storage, SOURCE_KEY, (value) => asIndexMap(value)) ?? {},
  );

  readonly favorites = computed(() => this.favoriteIdsState());
  readonly recent = computed(() => this.recentIdsState());
  readonly theme = computed(() => this.themeState());
  readonly volume = computed(() => this.volumeState());
  readonly hasFavorites = computed(() => this.favoriteIdsState().size > 0);

  isFavorite(channelId: string): boolean {
    return this.favoriteIdsState().has(channelId);
  }

  toggleFavorite(channelId: string): boolean {
    const next = new Set(this.favoriteIdsState());
    if (next.has(channelId)) {
      next.delete(channelId);
    } else {
      next.add(channelId);
    }
    this.favoriteIdsState.set(next);
    writeJson(this.storage, FAVORITES_KEY, [...next]);
    return next.has(channelId);
  }

  rememberChannel(channelId: string): void {
    const current = this.recentIdsState();
    if (current[0] === channelId) {
      return;
    }
    const next = [channelId, ...current.filter((id) => id !== channelId)].slice(0, MAX_RECENT);
    this.recentIdsState.set(next);
    writeJson(this.storage, RECENT_KEY, next);
  }

  setTheme(theme: ThemePreference): void {
    this.themeState.set(theme);
    writeJson(this.storage, THEME_KEY, theme);
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.8));
    this.volumeState.set(clamped);
    writeJson(this.storage, VOLUME_KEY, clamped);
  }

  preferredSourceIndex(channelId: string): number {
    return this.sourceIndexState()[channelId] ?? 0;
  }

  setPreferredSourceIndex(channelId: string, index: number): void {
    const next = { ...this.sourceIndexState(), [channelId]: index };
    this.sourceIndexState.set(next);
    writeJson(this.storage, SOURCE_KEY, next);
  }
}
