import { Injectable } from '@angular/core';
import { PlaybackTelemetry, type PlaybackEvent, type PlaybackRecord } from './playback-telemetry';

/**
 * Root-scoped holder for the playback telemetry buffer.
 *
 * Deliberately NOT configured with a sink: nothing leaves the device unless the
 * application explicitly supplies a collector (see `PlaybackTelemetry`). The
 * player only writes into the bounded ring buffer, and tests read it back with
 * `snapshot()`.
 */
@Injectable({ providedIn: 'root' })
export class PlaybackTelemetryService {
  private readonly telemetry = new PlaybackTelemetry();

  /** Whether this build sends anything off-device. Always false today. */
  get collectionEnabled(): boolean {
    return this.telemetry.collectionEnabled;
  }

  record(event: PlaybackEvent): void {
    this.telemetry.record(event);
  }

  snapshot(): readonly PlaybackRecord[] {
    return this.telemetry.snapshot();
  }
}
