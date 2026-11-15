import { InjectionToken, type Provider } from '@angular/core';
import { DEFAULT_CONFIG, type RebuildConfig } from './rebuild-config';

export const REBUILD_CONFIG = new InjectionToken<RebuildConfig>('REBUILD_CONFIG', {
  factory: () => DEFAULT_CONFIG,
});

export function provideRebuildConfig(overrides: Partial<RebuildConfig> = {}): Provider {
  return {
    provide: REBUILD_CONFIG,
    useValue: { ...DEFAULT_CONFIG, ...overrides },
  };
}
