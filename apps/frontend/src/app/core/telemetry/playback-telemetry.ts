/**
 * Lightweight playback telemetry.
 *
 * What this is for: knowing, in the field, which sources start and which fail,
 * and how long users wait for the first frame. It is deliberately small.
 *
 * Contract (all of it testable, see playback-telemetry.spec.ts):
 *
 * - **Nothing leaves the device by default.** No `fetch`, no `sendBeacon`, no
 *   third-party endpoint. The sink is an in-memory ring buffer the app can read.
 *   A same-origin collector is the ONLY way to send anything, and it is never
 *   configured by this module on its own.
 *
 * - **No timers.** There is no `setInterval` anywhere in this file: events are
 *   recorded when the player transitions, so a paused or failed player costs
 *   exactly zero work. Nothing runs per frame.
 *
 * - **Bounded.** At most `MAX_EVENTS` records are kept; older ones are dropped.
 *   When the optional collector is enabled, at most `BATCH_SIZE` records leave
 *   per flush and flushes are throttled to one per `MIN_FLUSH_INTERVAL_MS`.
 *
 * - **Non-identifying.** Records carry a channel id, a source format and engine
 *   kind, timings and error codes. Never a URL with query values, never a title,
 *   never anything that identifies the viewer. `sanitizeUrl` keeps only the
 *   origin and path.
 */

/** One thing that happened to one playback attempt. */
export interface PlaybackEvent {
  readonly name:
    | 'playback-start'
    | 'first-frame'
    | 'buffering'
    | 'playing'
    | 'error'
    | 'source-fallback'
    | 'control';
  /** Which channel, if the event is about one. */
  readonly channelId?: string;
  /** Source container kind (`hls`, `dash`, `progressive`, `youtube`). */
  readonly format?: string;
  /** Engine that actually ran (`hls`, `dash`, `native`, `youtube`). */
  readonly engine?: string;
  /** For `error`: the classified code. For `control`: the control name. */
  readonly code?: string;
  /** Milliseconds of user-visible waiting, when the event measures one. */
  readonly durationMs?: number;
  /** Originating URL reduced to origin + path (never query or fragment). */
  readonly origin?: string;
}

/** A retained record: the event plus when it happened relative to the session. */
export interface PlaybackRecord extends PlaybackEvent {
  /** Milliseconds since the telemetry session started. */
  readonly at: number;
}

/**
 * Receives batches when a collector is configured. The app opts in by passing
 * one; this module never creates its own transport.
 */
export type TelemetrySink = (batch: readonly PlaybackRecord[]) => void;

export interface TelemetryOptions {
  /** Where to send batches, when the embedding app enables collection. */
  readonly sink?: TelemetrySink;
  /** Hard cap on retained records. */
  readonly maxEvents?: number;
  /** Hard cap on records per flush. */
  readonly batchSize?: number;
  /** Minimum time between flushes, in milliseconds. */
  readonly minFlushIntervalMs?: number;
  /** Clock, injected for tests. */
  readonly now?: () => number;
}

export const MAX_EVENTS = 200;
export const BATCH_SIZE = 25;
export const MIN_FLUSH_INTERVAL_MS = 30_000;

/**
 * Reduces a URL to `origin + pathname`.
 *
 * Query strings routinely carry tokens and subscriber identifiers, and a
 * fragment can carry a channel key; neither belongs in a telemetry record. A
 * URL that does not parse is dropped rather than recorded verbatim.
 */
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url, 'http://localhost');
    return `${parsed.origin === 'http://localhost' ? '' : parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Records playback events into a bounded in-memory ring buffer.
 *
 * One instance is provided at the app root; the player calls `record` from the
 * transitions it already observes.
 */
export class PlaybackTelemetry {
  private readonly sink: TelemetrySink | undefined;
  private readonly maxEvents: number;
  private readonly batchSize: number;
  private readonly minFlushIntervalMs: number;
  private readonly now: () => number;

  private readonly events: PlaybackRecord[] = [];
  private readonly pending: PlaybackRecord[] = [];
  private startedAt: number;
  private lastFlushAt = 0;
  /** Timestamp of the last `playback-start`, for the first-frame measurement. */
  private startedWaitingAt: number | undefined;

  constructor(options: TelemetryOptions = {}) {
    this.sink = options.sink;
    this.maxEvents = Math.max(1, options.maxEvents ?? MAX_EVENTS);
    this.batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
    this.minFlushIntervalMs = Math.max(0, options.minFlushIntervalMs ?? MIN_FLUSH_INTERVAL_MS);
    this.now = options.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
    this.startedAt = this.now();
  }

  /** True when a collector is configured, i.e. anything could ever leave. */
  get collectionEnabled(): boolean {
    return this.sink !== undefined;
  }

  /**
   * Records one event. Returns the stored record so callers can assert on it.
   *
   * Nothing is sent unless a sink exists; when one does, it receives a batch at
   * most once per `minFlushIntervalMs` and never more than `batchSize` records.
   */
  record(event: PlaybackEvent): PlaybackRecord {
    const at = Math.max(0, Math.round(this.now() - this.startedAt));
    const stored: PlaybackRecord = { ...event, at };

    // `playback-start` opens a wait; `first-frame` closes it and measures the gap.
    if (event.name === 'playback-start') {
      this.startedWaitingAt = this.now();
    } else if (event.name === 'first-frame' && this.startedWaitingAt !== undefined) {
      const durationMs = Math.max(0, Math.round(this.now() - this.startedWaitingAt));
      this.startedWaitingAt = undefined;
      this.push({ ...stored, durationMs });
      this.flushIfDue();
      return this.events[this.events.length - 1] as PlaybackRecord;
    }

    this.push(stored);
    this.flushIfDue();
    return stored;
  }

  /** Retained records, oldest first. */
  snapshot(): readonly PlaybackRecord[] {
    return this.events.slice();
  }

  /** Clears retained and pending records. */
  reset(): void {
    this.events.length = 0;
    this.pending.length = 0;
    this.startedWaitingAt = undefined;
    this.startedAt = this.now();
    this.lastFlushAt = 0;
  }

  private push(record: PlaybackRecord): void {
    this.events.push(record);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (this.sink) {
      this.pending.push(record);
      if (this.pending.length > this.maxEvents) {
        this.pending.splice(0, this.pending.length - this.maxEvents);
      }
    }
  }

  /**
   * Sends at most the backlog, one batch at a time, when the interval allows.
   *
   * The first flush is allowed immediately (`lastFlushAt` starts at 0), so a
   * short session still reports; after that the interval governs, and a
   * throttle window releases at most `batchSize` records. Anything held back
   * stays queued for the next allowed flush and is never dropped — losing a
   * failure because it landed inside the window would defeat the point.
   */
  private flushIfDue(): void {
    if (!this.sink || this.pending.length === 0) {
      return;
    }
    const now = this.now();
    if (this.lastFlushAt !== 0 && now - this.lastFlushAt < this.minFlushIntervalMs) {
      return;
    }
    this.lastFlushAt = now;
    // One batch per allowed flush, dropping anything the throttle held back.
    const batch = this.pending.splice(0, this.batchSize);
    try {
      this.sink(batch);
    } catch {
      // A broken collector must never break playback: the events are already
      // retained in the ring buffer, which is the copy that matters.
    }
  }
}
