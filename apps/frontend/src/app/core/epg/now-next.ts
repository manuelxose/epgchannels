import type { ChannelSchedule, EpgProgram } from '../models/catalog.model';

export interface NowNext {
  readonly now?: EpgProgram;
  /** 0..1 progress of the current programme. */
  readonly progress: number;
  readonly next?: EpgProgram;
  readonly after?: EpgProgram;
}

/**
 * Resolves the programme on air at `at` plus the two following ones.
 * Programs are sorted and non-overlapping by construction; when they do overlap,
 * the earliest-starting candidate wins deterministically.
 */
export function resolveNowNext(schedule: ChannelSchedule | undefined, at: Date): NowNext {
  if (!schedule || schedule.programs.length === 0) {
    return { progress: 0 };
  }
  const timestamp = at.getTime();
  const programs = schedule.programs;
  let nowIndex = -1;
  for (let index = 0; index < programs.length; index += 1) {
    const program = programs[index];
    if (program.start.getTime() <= timestamp && timestamp < program.end.getTime()) {
      nowIndex = index;
      break;
    }
  }
  if (nowIndex === -1) {
    const upcoming = programs.findIndex((program) => program.start.getTime() > timestamp);
    if (upcoming === -1) {
      return { progress: 0 };
    }
    return { progress: 0, next: programs[upcoming], after: programs[upcoming + 1] };
  }
  const now = programs[nowIndex];
  const span = now.end.getTime() - now.start.getTime();
  const progress = span > 0 ? Math.min(1, Math.max(0, (timestamp - now.start.getTime()) / span)) : 0;
  return { now, progress, next: programs[nowIndex + 1], after: programs[nowIndex + 2] };
}

/** Formats a compact clock label in the user's locale (24h style where available). */
export function formatTimeRange(start: Date, end: Date, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  return `${time.format(start)} – ${time.format(end)}`;
}

/** True when the guide snapshot covers `at`; used to decide whether a refresh is needed. */
export function scheduleCovers(schedule: ChannelSchedule | undefined, at: Date): boolean {
  if (!schedule || schedule.programs.length === 0) {
    return false;
  }
  const timestamp = at.getTime();
  return schedule.programs.some((program) => program.start.getTime() <= timestamp && timestamp < program.end.getTime());
}
