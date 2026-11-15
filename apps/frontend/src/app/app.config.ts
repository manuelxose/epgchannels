import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { provideRebuildConfig } from './core/config/rebuild-config.token';
import { DEFAULT_CONFIG } from './core/config/rebuild-config';
import { YOUTUBE_LIVE_RESOLVER } from './core/state/player.controller';
import { createYoutubeLiveResolver, sharedDataApiClients } from './core/integrations/youtube-runtime';

/**
 * The API base URL can be overridden at build time through `TDT_API_BASE_URL`
 * (for example to point a preview build at a staging API). No configuration of
 * this application can point it at a third-party catalogue: that dependency no
 * longer exists in the client.
 */
const env: Record<string, string | undefined> = {};

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
    ),
    provideRebuildConfig({
      apiBaseUrl: env['TDT_API_BASE_URL'] ?? DEFAULT_CONFIG.apiBaseUrl,
    }),
    /*
     * YouTube channel → live-video resolution. The adapter is inert until the
     * deployment provides a (restricted) Data API key at `window.TDT_YOUTUBE_API_KEY`;
     * without one it reports "cannot check", never "the channel is offline".
     */
    {
      provide: YOUTUBE_LIVE_RESOLVER,
      useValue: createYoutubeLiveResolver(sharedDataApiClients()),
    },
  ],
};
