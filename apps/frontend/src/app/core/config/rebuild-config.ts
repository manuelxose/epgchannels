/**
 * Environment-injected configuration.
 *
 * Since TDT-API-01 the frontend has exactly **one** data source: our own API.
 * There is no URL to a third-party catalogue and no bundled snapshot of one;
 * when the API is unreachable the UI says so instead of showing foreign data.
 */
export interface RebuildConfig {
  /** Root of our API v1: same-origin `/api/v1` in development, absolute in production. */
  readonly apiBaseUrl: string;
  /** Network timeout for one API call, in milliseconds. */
  readonly fetchTimeoutMs: number;
  /** How often the guide window is refreshed while a channel is open. */
  readonly epgRefreshMs: number;
  /** Page size requested from `/channels` while walking the catalogue. */
  readonly cataloguePageSize: number;
}

export const DEFAULT_CONFIG: RebuildConfig = {
  apiBaseUrl: '/api/v1',
  fetchTimeoutMs: 12_000,
  epgRefreshMs: 30 * 60_000,
  cataloguePageSize: 100,
};
