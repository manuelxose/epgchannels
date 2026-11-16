/**
 * Ingestion metrics — the shared shape every module imports (contract §3.4).
 *
 * Pure: no clock, no I/O. The accumulator is a plain reducer so a run can be
 * rebuilt deterministically from candidate lists and remains testable.
 *
 * This module does *not*: measure wall-clock time (callers pass `durationMs`),
 * persist anything, or decide pass/fail for a run.
 */
import type { SourceCandidateDoc } from './provenance.js';

export interface IngestionMetrics {
  upstream: string;
  importedEntries: number;
  rejectedEntries: number;
  duplicateCandidates: number;
  canonicalChannels: number;
  newChannels: number;
  unmatchedEntries: number;
  manualReview: number;
  candidatesPerChannel: { avg: number; max: number; histogram: Record<string, number> };
  byCountry: Record<string, number>;
  byLanguage: Record<string, number>;
  byGroup: Record<string, number>;
  durationMs: number;
}

export interface MetricsInput {
  upstream: string;
  candidates: readonly SourceCandidateDoc[];
  rejectedEntries?: number;
  canonicalChannels?: number;
  newChannels?: number;
  manualReview?: number;
  durationMs?: number;
}

const histogramBucket = (count: number): string => {
  if (count <= 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
};

const bump = (target: Record<string, number>, key: string): void => {
  target[key] = (target[key] ?? 0) + 1;
};

/** Mutable accumulator with the exact shape of {@link IngestionMetrics}. */
export function emptyMetrics(upstream: string): IngestionMetrics {
  return {
    upstream,
    importedEntries: 0,
    rejectedEntries: 0,
    duplicateCandidates: 0,
    canonicalChannels: 0,
    newChannels: 0,
    unmatchedEntries: 0,
    manualReview: 0,
    candidatesPerChannel: { avg: 0, max: 0, histogram: {} },
    byCountry: {},
    byLanguage: {},
    byGroup: {},
    durationMs: 0,
  };
}

/**
 * Builds the metrics of one ingestion run from its candidate list.
 *
 * `duplicateCandidates` counts candidates whose state is `duplicate`;
 * `unmatchedEntries` the `unmatched` ones; a candidate counts toward
 * `candidatesPerChannel` only once it carries a `channelId`. It does not
 * mutate the candidates and does not infer channels that were never linked.
 */
export function accumulateMetrics(input: MetricsInput): IngestionMetrics {
  const metrics = emptyMetrics(input.upstream);
  metrics.rejectedEntries = input.rejectedEntries ?? 0;
  metrics.canonicalChannels = input.canonicalChannels ?? 0;
  metrics.newChannels = input.newChannels ?? 0;
  metrics.manualReview = input.manualReview ?? 0;
  metrics.durationMs = input.durationMs ?? 0;

  const perChannel = new Map<string, number>();
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (seen.has(candidate._id)) continue; // idempotent accumulation
    seen.add(candidate._id);
    if (candidate.state === 'rejected') {
      metrics.rejectedEntries += 1;
      continue;
    }
    metrics.importedEntries += 1;
    if (candidate.state === 'duplicate') metrics.duplicateCandidates += 1;
    if (candidate.state === 'unmatched') metrics.unmatchedEntries += 1;
    if (candidate.country !== null) bump(metrics.byCountry, candidate.country);
    if (candidate.language !== null) bump(metrics.byLanguage, candidate.language);
    if (candidate.groupTitle !== null && candidate.groupTitle !== '') {
      bump(metrics.byGroup, candidate.groupTitle);
    }
    if (candidate.channelId !== null) {
      perChannel.set(candidate.channelId, (perChannel.get(candidate.channelId) ?? 0) + 1);
    }
  }

  let max = 0;
  let total = 0;
  const histogram: Record<string, number> = {};
  for (const count of perChannel.values()) {
    total += count;
    max = Math.max(max, count);
    bump(histogram, histogramBucket(count));
  }
  metrics.candidatesPerChannel = {
    avg: perChannel.size === 0 ? 0 : Math.round((total / perChannel.size) * 100) / 100,
    max,
    histogram,
  };
  if (metrics.canonicalChannels === 0) metrics.canonicalChannels = perChannel.size;
  return metrics;
}

/**
 * Merges several runs of the same upstream into one metric set (maintainer
 * reporting). Sums counts, rebuilds ratios; it does not recompute histograms
 * that were not recorded per run.
 */
export function mergeMetrics(upstream: string, parts: readonly IngestionMetrics[]): IngestionMetrics {
  const merged = emptyMetrics(upstream);
  let histogramWeight = 0;
  for (const part of parts) {
    merged.importedEntries += part.importedEntries;
    merged.rejectedEntries += part.rejectedEntries;
    merged.duplicateCandidates += part.duplicateCandidates;
    merged.newChannels += part.newChannels;
    merged.unmatchedEntries += part.unmatchedEntries;
    merged.manualReview += part.manualReview;
    merged.durationMs += part.durationMs;
    merged.canonicalChannels += part.canonicalChannels;
    merged.candidatesPerChannel.max = Math.max(merged.candidatesPerChannel.max, part.candidatesPerChannel.max);
    histogramWeight += part.canonicalChannels;
    for (const [key, count] of Object.entries(part.candidatesPerChannel.histogram)) {
      bump(merged.candidatesPerChannel.histogram, key);
    }
    for (const [key, count] of Object.entries(part.byCountry)) merged.byCountry[key] = (merged.byCountry[key] ?? 0) + count;
    for (const [key, count] of Object.entries(part.byLanguage)) merged.byLanguage[key] = (merged.byLanguage[key] ?? 0) + count;
    for (const [key, count] of Object.entries(part.byGroup)) merged.byGroup[key] = (merged.byGroup[key] ?? 0) + count;
  }
  merged.candidatesPerChannel.avg =
    histogramWeight === 0
      ? 0
      : Math.round((merged.importedEntries / merged.canonicalChannels) * 100) / 100;
  return merged;
}
