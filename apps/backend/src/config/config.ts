/**
 * Runtime configuration, validated at boot.
 *
 * Every value has an explicit default except the admin bootstrap secret. The
 * process refuses to start with an invalid configuration rather than failing
 * later on the first request.
 */
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads `<repo>/.env` when it exists, without overriding variables the process
 * environment already defines (so a deployment/CI value always wins).
 * Uses Node's built-in dotenv: no extra dependency, no parsing surprises.
 */
export function loadDotEnv(startDirectory: string): void {
  let directory = resolve(startDirectory);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Directory of this module (works for both `src/` and `dist/`). */
export function moduleDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4010),
  /** API base path. Versioned: consumers must not depend on unversioned paths. */
  API_BASE_PATH: z.string().default('/api/v1'),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27117/?replicaSet=rs0'),
  MONGODB_DB: z.string().min(1).default('tdt_platform'),

  /** Optional cache. When unset the cache is a no-op, never a failure mode. */
  REDIS_URL: z.string().min(1).optional(),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Browser origins allowed to call the public API. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:4200,http://127.0.0.1:4200,http://localhost:4011,http://127.0.0.1:4011')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600).default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100000).default(300),

  /**
   * Bootstrap credential for the first administrator, supplied only through the
   * environment. It is hashed immediately and never stored in clear text.
   * Not required when at least one administrator already exists.
   */
  ADMIN_BOOTSTRAP_TOKEN: z.string().min(32).optional(),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),

  /** Shared secret for server-to-server consumers (GuíaTV). Optional. */
  SERVICE_API_KEY_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),

  /**
   * Network guard: when true, any request to a host in
   * `BLOCKED_EGRESS_HOSTS` fails. Used by the independence test.
   */
  EGRESS_GUARD_ENABLED: booleanish.default(false),
  BLOCKED_EGRESS_HOSTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    ),

  /** Outbound timeouts for provider verification and guide ingestion. */
  EGRESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  /** Jobs. Off by default so tests never run background work implicitly. */
  JOBS_ENABLED: booleanish.default(false),
  EPG_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  SOURCE_VERIFY_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(180),

  /** Optional YouTube Data API key for resolving /channel/<id>/live. */
  YOUTUBE_API_KEY: z.string().min(10).optional(),
  /*
   * YouTube channel resolution. The scheduled job is what keeps playback
   * observable for the ~200 catalogue channels that publish a channel page
   * instead of a video; the API itself never contacts YouTube.
   */
  YOUTUBE_RESOLVE_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  /** Channels resolved per run: the only knob that sets the external request rate. */
  YOUTUBE_RESOLVE_BATCH: z.coerce.number().int().min(1).max(500).default(40),

  /*
   * Automated stream verification (TDT-API-02D). Off by default: turning it on
   * makes the platform contact third-party origins on a schedule, which is an
   * operator decision, not a default. Every bound below is a *load* bound on
   * somebody else's server, so they are conservative and never unbounded.
   */
  VERIFY_ENABLED: booleanish.default(false),
  /** Checks in flight in one round, across all hosts. */
  VERIFY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** Checks in flight to any single host: the per-provider politeness limit. */
  VERIFY_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  VERIFY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  /** Manifest body bound (contract §2: 2 MiB). */
  VERIFY_MAX_BYTES: z.coerce.number().int().min(1024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  /** Segments sampled for diagnosis (contract §4: N=2, never the whole list). */
  VERIFY_SEGMENT_SAMPLE: z.coerce.number().int().min(0).max(8).default(2),
  /** Layer 6 is manual-only by default (contract §4). */
  VERIFY_BROWSER_ENABLED: booleanish.default(false),
  VERIFY_CIRCUIT_THRESHOLD: z.coerce.number().int().min(1).max(50).default(5),
  VERIFY_CIRCUIT_MAX_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
});
export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && config.EGRESS_GUARD_ENABLED) {
    throw new ConfigError('EGRESS_GUARD_ENABLED is a test-only switch and is refused in production.');
  }
  return config;
}
