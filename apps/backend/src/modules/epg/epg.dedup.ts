/**
 * Duplicate detection for guide emissions (TDT-API-02FG).
 *
 * Two guides, or one guide ingested twice under different keys, can describe the
 * same broadcast. A duplicate is *marked*, never deleted: the losing emission
 * keeps its row with `duplicateOf` pointing at the winner, so the decision is
 * auditable and reversible.
 *
 * The test is deliberately narrow — a false merge hides a real broadcast, which
 * is worse than showing two rows an operator can reject. An emission is a
 * duplicate when, on the same channel:
 *
 * 1. its window **overlaps** another's (half-open intervals: an emission that
 *    starts exactly when another ends is not an overlap), and
 * 2. the normalised titles are identical.
 *
 * "Normalised" folds case, diacritics, punctuation and collapsed whitespace, so
 * `Telediario 2ª edición` and `TELEDIARIO 2a EDICION.` are one title.
 */

export interface ProgrammeWindow {
  readonly id: string;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  /** Priority for winning a tie; higher wins. Defaults to 0. */
  readonly priority?: number;
}

/** Folds a title to its comparison form. Pure and stable. */
export function normaliseTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Ordinal indicators (`2ª`, `1º`, `3ᵉ`) do not decompose under NFD, and a
    // schedule writes them inconsistently; fold them to the plain letter.
    .replace(/[ªᵃ]/gu, 'a')
    .replace(/[ºᵒ]/gu, 'o')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Half-open overlap: `[aStart, aEnd)` against `[bStart, bEnd)`. */
export function windowsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

export interface DuplicateGroups {
  /** `id → id` of the emission that wins. Only losers appear as keys. */
  readonly duplicates: ReadonlyMap<string, string>;
  /** Number of emissions marked as duplicates. */
  readonly count: number;
}

/**
 * Classifies the given emissions into winners and duplicates.
 *
 * The winner of a group is the emission with the highest `priority`; ties are
 * broken by the earliest start and then by `id`, so the result does not depend
 * on the order the rows were read. This is the *within-batch* half; the
 * cross-batch half lives in `EpgService` (it must look at stored rows).
 */
export function findDuplicatePairs(programmes: readonly ProgrammeWindow[]): DuplicateGroups {
  const dates = programmes
    .map((programme) => ({ ...programme, startMs: programme.start.getTime(), endMs: programme.end.getTime() }))
    .filter((programme) => Number.isFinite(programme.startMs) && Number.isFinite(programme.endMs))
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));

  const duplicates = new Map<string, string>();

  // Sweep line: a candidate only needs comparing with emissions that start
  // before it ends, so the comparisons stay local to a window.
  for (let index = 0; index < dates.length; index += 1) {
    const current = dates[index];
    if (!current) continue;
    const title = normaliseTitle(current.title);
    if (title.length === 0) continue;
    // Group members are the *transitive closure* of "overlaps and shares the
    // title": three copies of one broadcast where only the outer two overlap
    // must still end as one winner and two duplicates.
    const members: (typeof dates)[number][] = [current];
    let frontier = 0;
    const visited = new Set<string>([current.id]);
    while (frontier < members.length) {
      const anchor = members[frontier];
      frontier += 1;
      if (!anchor) continue;
      for (let next = index + 1; next < dates.length; next += 1) {
        const other = dates[next];
        if (!other || visited.has(other.id)) continue;
        if (other.startMs >= anchor.endMs) break;
        if (!windowsOverlap(anchor.start, anchor.end, other.start, other.end)) continue;
        if (normaliseTitle(other.title) !== title) continue;
        visited.add(other.id);
        members.push(other);
      }
    }
    if (members.length < 2) continue;
    const group = [...members].sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        a.startMs - b.startMs ||
        a.id.localeCompare(b.id),
    );
    const winner = group[0];
    if (!winner) continue;
    for (const member of group.slice(1)) {
      if (member.id !== winner.id && !duplicates.has(member.id)) duplicates.set(member.id, winner.id);
    }
  }
  return { duplicates, count: duplicates.size };
}
