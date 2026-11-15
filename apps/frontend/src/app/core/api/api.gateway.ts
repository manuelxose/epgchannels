/**
 * The single HTTP entry point to our API.
 *
 * Components never build a URL. Everything goes through the official SDK
 * (`@tdt/api-client`), configured with one base URL, so the browser has exactly
 * one origin to trust and the SSR/server path can point somewhere else without
 * touching a component.
 */
import { Injectable, inject } from '@angular/core';
import { ApiError, createTdtClient, type TdtClient } from '@tdt/api-client';
import { REBUILD_CONFIG } from '../config/rebuild-config.token';

@Injectable({ providedIn: 'root' })
export class ApiGateway {
  private readonly config = inject(REBUILD_CONFIG);

  readonly client: TdtClient = createTdtClient({
    baseUrl: this.config.apiBaseUrl,
    timeoutMs: this.config.fetchTimeoutMs,
  });

  /** True when the failure is a "this channel does not exist" answer. */
  static isNotFound(error: unknown): boolean {
    return error instanceof ApiError && error.isNotFound;
  }

  /** Human-readable message for the UI, never a raw stack. */
  static describe(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.isRateLimited) {
        return 'Se han hecho demasiadas solicitudes. Vuelve a intentarlo en unos segundos.';
      }
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
