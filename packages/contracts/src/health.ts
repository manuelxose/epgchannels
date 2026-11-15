/**
 * Health and operational contract (`/api/v1/health`, `/metrics`).
 */
import { z } from 'zod';
import { isoTimestampSchema } from './common.js';

export const dependencyStateSchema = z.enum(['up', 'down', 'disabled', 'degraded']);
export type DependencyState = z.infer<typeof dependencyStateSchema>;

export const dependencyHealthSchema = z.object({
  /** `mongodb`, `redis`, … */
  name: z.string(),
  state: dependencyStateSchema,
  /** Round-trip latency of the probe, when it answered. */
  latencyMs: z.number().nullable(),
  message: z.string().nullable(),
});
export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

export const healthStatusSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const healthResponseSchema = z.object({
  status: healthStatusSchema,
  /** API build/version served. */
  version: z.string(),
  apiVersion: z.literal('v1'),
  uptimeSeconds: z.number(),
  now: isoTimestampSchema,
  dependencies: z.array(dependencyHealthSchema),
  /** Catalogue counts prove the database, not a fixture, answers. */
  data: z.object({
    channels: z.number().int().min(0),
    publishedChannels: z.number().int().min(0),
    sources: z.number().int().min(0),
    programmes: z.number().int().min(0),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Prometheus-style text exposition is served at `/metrics` (not JSON). */
export const metricsContentType = 'text/plain; version=0.0.4; charset=utf-8';
