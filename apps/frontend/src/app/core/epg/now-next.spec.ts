import { describe, expect, it } from 'vitest';
import { formatTimeRange, resolveNowNext } from './now-next';
import type { ChannelSchedule, EpgProgram } from '../models/catalog.model';

function program(startMinutes: number, endMinutes: number, title: string): EpgProgram {
  const base = Date.UTC(2026, 10, 13, 10, 0, 0);
  return {
    id: `${title}:${startMinutes}`,
    title,
    description: '',
    start: new Date(base + startMinutes * 60_000),
    end: new Date(base + endMinutes * 60_000),
  };
}

function schedule(...programs: EpgProgram[]): ChannelSchedule {
  return { epgId: 'Test.TV', programs };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 13, 10, 0, 0) + minutes * 60_000);

describe('resolveNowNext', () => {
  const day = schedule(program(0, 60, 'Uno'), program(60, 120, 'Dos'), program(120, 180, 'Tres'));

  it('finds the current programme and the two following ones', () => {
    const result = resolveNowNext(day, at(90));
    expect(result.now?.title).toBe('Dos');
    expect(result.next?.title).toBe('Tres');
    expect(result.after).toBeUndefined();
  });

  it('computes progress inside the current programme', () => {
    expect(resolveNowNext(day, at(60))?.progress).toBe(0);
    expect(resolveNowNext(day, at(90))?.progress).toBeCloseTo(0.5, 5);
    expect(resolveNowNext(day, at(119.99))?.progress).toBeGreaterThan(0.99);
  });

  it('treats the exact end boundary as the next programme', () => {
    const result = resolveNowNext(day, at(60));
    expect(result.now?.title).toBe('Dos');
  });

  it('returns only upcoming programmes outside coverage', () => {
    const result = resolveNowNext(day, at(-30));
    expect(result.now).toBeUndefined();
    expect(result.next?.title).toBe('Uno');
    expect(result.after?.title).toBe('Dos');
    expect(result.progress).toBe(0);
  });

  it('returns an empty result after the schedule ends', () => {
    const result = resolveNowNext(day, at(500));
    expect(result.now).toBeUndefined();
    expect(result.next).toBeUndefined();
    expect(result.progress).toBe(0);
  });

  it('handles missing or empty schedules', () => {
    expect(resolveNowNext(undefined, at(10)).now).toBeUndefined();
    expect(resolveNowNext(schedule(), at(10)).now).toBeUndefined();
  });

  it('never reports progress outside 0..1 for degenerate ranges', () => {
    const degenerate = schedule({ ...program(0, 60, 'Zero'), end: new Date(Date.UTC(2026, 10, 13, 10, 0, 0)) });
    const result = resolveNowNext(degenerate, at(10));
    expect(result.progress).toBeGreaterThanOrEqual(0);
    expect(result.progress).toBeLessThanOrEqual(1);
  });
});

describe('formatTimeRange', () => {
  it('formats a 24h range in the requested locale', () => {
    const start = new Date(Date.UTC(2026, 10, 13, 9, 0, 0));
    const end = new Date(Date.UTC(2026, 10, 13, 11, 30, 0));
    const label = formatTimeRange(start, end, 'es-ES');
    expect(label).toMatch(/^\d{2}:\d{2} – \d{2}:\d{2}$/);
    expect(label).toContain('–');
  });
});
