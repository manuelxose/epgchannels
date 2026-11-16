/**
 * Migration: reclassify sources whose declared format does not match the address.
 *
 * Audited defect: 26 sources were stored as `hls` while their URL is a Twitch
 * player page (`player.twitch.tv/?channel=…`), which is HTML, not a playlist.
 * Our HLS engine cannot play that, so those channels failed for a reason the
 * catalogue never admitted.
 *
 * The rule now lives in `effectiveSourceType` (used by the importer); this script
 * applies it to what is already stored, so no re-import is needed.
 */
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import type { PlaybackSourceDoc } from '../infrastructure/schema.js';
import { effectiveSourceType } from '../jobs/catalogue-import.js';

export interface ReclassificationReport {
  readonly inspected: number;
  readonly changed: number;
  readonly byTransition: Record<string, number>;
  readonly apply?: boolean;
}

export async function reclassifySourceTypes(
  database: DatabaseHandle,
  options: { apply?: boolean } = {},
): Promise<ReclassificationReport> {
  const sources = await database
    .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
    .find({})
    .toArray();

  const byTransition: Record<string, number> = {};
  const updates: { id: string; type: string }[] = [];

  for (const source of sources) {
    if (!source.url || !source.type) continue;
    // Only these two can be wrong: `external`, `youtube` and `dash` are explicit.
    if (!['hls', 'official-embed'].includes(source.type)) continue;
    const effective = effectiveSourceType(source.type === 'hls' ? 'm3u8' : 'iframe', source.url);
    if (effective === source.type) continue;
    const key = `${source.type}->${effective}`;
    byTransition[key] = (byTransition[key] ?? 0) + 1;
    updates.push({ id: source._id, type: effective });
  }

  if (options.apply) {
    for (const update of updates) {
      await database.collection<PlaybackSourceDoc>(COLLECTIONS.sources).updateOne(
        { _id: update.id },
        { $set: { type: update.type, updatedAt: new Date() }, $inc: { revision: 1 } },
      );
    }
  }

  return {
    inspected: sources.length,
    changed: updates.length,
    byTransition,
    ...(options.apply === undefined ? {} : { apply: options.apply }),
  };
}
