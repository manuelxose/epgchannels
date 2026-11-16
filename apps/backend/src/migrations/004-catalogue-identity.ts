/**
 * Migration `004-catalogue-identity` — backfills the catalogue identity fields
 * on every pre-existing channel and creates the identity indexes.
 *
 * Backward compatible and non-destructive:
 * - it reads every channel, skips any that already carries `identity`, and
 *   `$set`s only `identity`, `publicSlugSource` and `catalogueState` — it never
 *   rewrites `_id`, `slug`, `mergedInto`, `aliases`, `provenance`, `epg` or any
 *   other field;
 * - pre-existing channels are backfilled `catalogueState: 'approved'`; records
 *   created afterwards default to `staging` in the store/ingestion, not here.
 *
 * The identity key is derived deterministically from the existing unique `slug`
 * plus the top-level `country`, so two pre-existing channels can never collide.
 * `identity.country` maps `INT` to `null` (it is not an ISO 3166-1 alpha-2 code)
 * and `language` maps `multi` to `und` (undetermined) rather than guessing.
 */
import type { DatabaseHandle } from '../infrastructure/mongo.js';
import { COLLECTIONS } from '../infrastructure/mongo.js';
import type { ChannelDoc as BaseChannelDoc } from '../infrastructure/schema.js';
import type { ChannelIdentityDoc } from '../catalogue/schema.js';
import {
  CHANNEL_IDENTITY_INDEXES,
  createCatalogueIndexes,
  dropCatalogueIndexes,
} from '../catalogue/schema.js';
import type { Migration } from './types.js';

/** Pre-migration channel shape: the identity extension may be absent. */
type PreIdentityChannel = BaseChannelDoc & { identity?: unknown };

const IDENTITY_INDEX_NAMES = CHANNEL_IDENTITY_INDEXES.map((index) => index.name);

/** BCP-47 primary language, lowercase; `multi`/empty map to `und`. */
function primaryLanguage(languageTag: string): string {
  const tag = languageTag.trim().toLowerCase();
  if (tag === '' || tag === 'multi') return 'und';
  const primary = tag.split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'und';
}

/** Deterministic identity backfill from fields that already exist. */
export function deriveIdentity(doc: BaseChannelDoc): ChannelIdentityDoc {
  const scope = doc.country.toLowerCase() || 'int';
  return {
    key: `${scope}:${doc.slug}`,
    country: /^[A-Za-z]{2}$/.test(doc.country) ? doc.country.toUpperCase() : null,
    language: primaryLanguage(doc.languageTag),
    variantKey: null,
    network: null,
  };
}

export async function migrateCatalogueIdentity(database: DatabaseHandle): Promise<void> {
  const channels = database.collection<PreIdentityChannel>(COLLECTIONS.channels);
  const docs = await channels.find({}).toArray();
  for (const doc of docs) {
    if (doc.identity !== undefined) continue; // already backfilled (idempotent)
    await channels.updateOne(
      { _id: doc._id },
      {
        $set: {
          identity: deriveIdentity(doc),
          publicSlugSource: null,
          catalogueState: 'approved',
        },
      },
    );
  }
  await createCatalogueIndexes(database.db, COLLECTIONS.channels, CHANNEL_IDENTITY_INDEXES);
}

export async function rollbackCatalogueIdentity(database: DatabaseHandle): Promise<void> {
  await database
    .collection<PreIdentityChannel>(COLLECTIONS.channels)
    .updateMany({}, { $unset: { identity: '', publicSlugSource: '', catalogueState: '' } });
  await dropCatalogueIndexes(database.db, COLLECTIONS.channels, IDENTITY_INDEX_NAMES);
}

export function buildCatalogueIdentityMigration(database: DatabaseHandle): Migration {
  return {
    name: '004-catalogue-identity',
    description: 'Backfill channel identity and catalogueState; add identity indexes.',
    run: () => migrateCatalogueIdentity(database),
    rollback: () => rollbackCatalogueIdentity(database),
  };
}
