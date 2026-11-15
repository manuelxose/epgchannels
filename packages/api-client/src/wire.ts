/**
 * Narrowing at the transport boundary.
 *
 * The generated wire types describe the JSON exactly, including fields that are
 * nullable on the wire (`playback.type` is `null` for a channel with nothing to
 * play). The domain types in `@tdt/contracts` are stricter. Rather than pushing
 * that difference into every consumer, the client narrows once, here.
 */
import type { PlaybackDescriptor } from '@tdt/contracts';
import type { PlaybackDescriptor as PlaybackDescriptorWire } from './generated/openapi-types.js';

/**
 * A descriptor as it arrives over HTTP. Identical to the domain type except that
 * fields known to be nullable on the wire stay nullable.
 */
export type WirePlaybackDescriptor = PlaybackDescriptorWire;

/**
 * Narrows a wire descriptor into the domain type.
 *
 * `type` describes the container of the *selected* source; when nothing is
 * selectable it is `null` on the wire, and the domain type keeps `null` too once
 * no option exists. No value is invented: when the wire says "nothing to play",
 * this produces "nothing to play".
 */
export function describePlayback(wire: PlaybackDescriptorWire): PlaybackDescriptor {
  return {
    ...wire,
    playback: {
      ...wire.playback,
      // `type` is nullable in both shapes: null means "nothing selectable".
      type: wire.playback.type,
      engine: wire.playback.engine,
      sourceId: wire.playback.sourceId,
      url: wire.playback.url,
      externalUrl: wire.playback.externalUrl,
      options: wire.playback.options.map((option) => ({
        sourceId: option.sourceId,
        label: option.label,
        type: option.type,
        engine: option.engine,
        url: option.url,
        externalUrl: option.externalUrl,
        geoRestricted: option.geoRestricted,
        preferred: option.preferred,
      })),
    },
  } as PlaybackDescriptor;
}
