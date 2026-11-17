/**
 * Duplicate detection and per-source scheduling (TDT-API-02FG).
 *
 * The duplicate rule is narrow on purpose — a false merge hides a real
 * broadcast — so these tests pin both halves of it: what must merge (same
 * channel, overlapping window, same normalised title) and what must never merge
 * (different title, touching-but-not-overlapping windows, different duration
 * that only looks similar).
 */
import { describe, expect, it } from 'vitest';
import { findDuplicatePairs, normaliseTitle, windowsOverlap } from './epg.dedup.js';
import {
  BASE_RETRY_MS,
  MAX_ATTEMPTS,
  nextRunAfter,
  planRuns,
  retryDelayMs,
  shouldRetry,
} from './epg.sync.js';

const at = (iso: string): Date => new Date(iso);

describe('title normalisation', () => {
  it('folds case, diacritics, punctuation and spacing', () => {
    expect(normaliseTitle('Telediario 2ª edición')).toBe('telediario 2a edicion');
    expect(normaliseTitle('  TELEDIARIO 2A EDICION. ')).toBe('telediario 2a edicion');
    expect(normaliseTitle('Tom & Jerry')).toBe('tom jerry');
    expect(normaliseTitle('!!!')).toBe('');
  });
});

describe('overlap', () => {
  it('treats windows as half-open, so touching emissions do not overlap', () => {
    expect(windowsOverlap(at('2026-11-14T20:00:00Z'), at('2026-11-14T21:00:00Z'), at('2026-11-14T20:30:00Z'), at('2026-11-14T21:30:00Z'))).toBe(true);
    expect(windowsOverlap(at('2026-11-14T20:00:00Z'), at('2026-11-14T21:00:00Z'), at('2026-11-14T21:00:00Z'), at('2026-11-14T22:00:00Z'))).toBe(false);
    expect(windowsOverlap(at('2026-11-14T20:00:00Z'), at('2026-11-14T21:00:00Z'), at('2026-11-14T19:00:00Z'), at('2026-11-14T20:00:00Z'))).toBe(false);
  });
});

describe('duplicate classification', () => {
  it('marks the overlapping emission with the same title, keeping the winner', () => {
    const { duplicates, count } = findDuplicatePairs([
      { id: 'a', title: 'Telediario', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T21:00:00Z') },
      { id: 'b', title: 'TELEDIARIO', start: at('2026-11-14T20:05:00Z'), end: at('2026-11-14T21:05:00Z') },
    ]);
    expect(count).toBe(1);
    // Same priority and title: the earlier start wins, deterministically.
    expect(duplicates.get('b')).toBe('a');
    expect(duplicates.has('a')).toBe(false);
  });

  it('never merges different titles or non-overlapping windows', () => {
    const { count } = findDuplicatePairs([
      { id: 'a', title: 'Telediario', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T21:00:00Z') },
      { id: 'b', title: 'Documental', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T21:00:00Z') },
      { id: 'c', title: 'Telediario', start: at('2026-11-14T21:00:00Z'), end: at('2026-11-14T22:00:00Z') },
    ]);
    expect(count).toBe(0);
  });

  it('honours priority when a source outranks another', () => {
    const { duplicates } = findDuplicatePairs([
      { id: 'low', title: 'Informe semanal', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T21:00:00Z'), priority: 1 },
      { id: 'high', title: 'Informe semanal', start: at('2026-11-14T20:10:00Z'), end: at('2026-11-14T21:10:00Z'), priority: 5 },
    ]);
    expect(duplicates.get('low')).toBe('high');
  });

  it('groups three emissions into one winner and is order-independent', () => {
    const rows = [
      { id: 'c', title: 'Cine', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T22:00:00Z') },
      { id: 'a', title: 'CINE', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T22:00:00Z') },
      { id: 'b', title: 'Cine', start: at('2026-11-14T21:00:00Z'), end: at('2026-11-14T22:00:00Z') },
    ];
    const forward = findDuplicatePairs(rows);
    const backward = findDuplicatePairs([...rows].reverse());
    expect(forward.count).toBe(2);
    expect([...forward.duplicates.entries()].sort()).toEqual([...backward.duplicates.entries()].sort());
    expect(forward.duplicates.get('b')).toBe('a');
    expect(forward.duplicates.get('c')).toBe('a');
  });

  it('ignores a title that normalises to nothing rather than merging blanks', () => {
    expect(
      findDuplicatePairs([
        { id: 'a', title: '   ', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T21:00:00Z') },
        { id: 'b', title: '!!!', start: at('2026-11-14T20:00:00Z'), end: at('2026-11-14T21:00:00Z') },
      ]).count,
    ).toBe(0);
  });
});

describe('per-source scheduling and bounded retries', () => {
  it('waits the full interval when the source is healthy', () => {
    expect(retryDelayMs(0, 60)).toBe(60 * 60_000);
    expect(nextRunAfter({ fetchIntervalMinutes: 60, consecutiveFailures: 0 }, at('2026-11-17T10:00:00Z')).toISOString()).toBe(
      '2026-11-17T11:00:00.000Z',
    );
  });

  it('backs off exponentially and never past the interval', () => {
    expect(retryDelayMs(1, 60)).toBe(BASE_RETRY_MS);
    expect(retryDelayMs(2, 60)).toBe(BASE_RETRY_MS * 2);
    expect(retryDelayMs(3, 60)).toBe(BASE_RETRY_MS * 4);
    // Bounded: a long outage does not push the next run past one interval.
    expect(retryDelayMs(20, 30)).toBe(30 * 60_000);
  });

  it('stops retrying inside a round after the cap', () => {
    const lastRunAt = at('2026-11-17T10:00:00Z');
    expect(shouldRetry({ lastRunAt: null, consecutiveFailures: 0 })).toBe(true);
    expect(shouldRetry({ lastRunAt, consecutiveFailures: MAX_ATTEMPTS - 1 })).toBe(true);
    expect(shouldRetry({ lastRunAt, consecutiveFailures: MAX_ATTEMPTS })).toBe(false);
  });

  it('plans the sources that are due, and ignores disabled or unpublished ones', () => {
    const now = at('2026-11-17T10:00:00Z');
    const planned = planRuns(
      [
        { _id: 'never-ran', name: 'A', ingestionEnabled: true, status: 'published', nextRunAt: null, lastRunAt: null, consecutiveFailures: 0 },
        { _id: 'due', name: 'B', ingestionEnabled: true, status: 'published', nextRunAt: at('2026-11-17T09:00:00Z'), lastRunAt: at('2026-11-17T09:00:00Z'), consecutiveFailures: 0 },
        { _id: 'backoff', name: 'C', ingestionEnabled: true, status: 'published', nextRunAt: at('2026-11-17T12:00:00Z'), lastRunAt: at('2026-11-17T09:00:00Z'), consecutiveFailures: 2 },
        { _id: 'disabled', name: 'D', ingestionEnabled: false, status: 'published', nextRunAt: null, lastRunAt: null, consecutiveFailures: 0 },
        { _id: 'draft', name: 'E', ingestionEnabled: true, status: 'review', nextRunAt: null, lastRunAt: null, consecutiveFailures: 0 },
      ],
      now,
    );
    expect(planned.map((run) => run.sourceId)).toEqual(['never-ran', 'due']);
  });

  it('forces a run when an operator asks, even inside the back-off window', () => {
    const planned = planRuns(
      [
        { _id: 'backoff', name: 'C', ingestionEnabled: true, status: 'published', nextRunAt: at('2026-11-17T12:00:00Z'), lastRunAt: at('2026-11-17T09:00:00Z'), consecutiveFailures: 9 },
      ],
      at('2026-11-17T10:00:00Z'),
      { force: true },
    );
    expect(planned).toHaveLength(1);
  });
});
