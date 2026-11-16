// Final measurements for the delivery report: what the platform actually holds.
import { MongoClient } from 'mongodb';
import { writeFileSync, mkdirSync } from 'node:fs';

const client = new MongoClient('mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const db = client.db('tdt_platform');

const channels = await db.collection('channels').find({}).toArray();
const sources = await db.collection('playback_sources').find({}).toArray();
const programmes = await db.collection('programmes').countDocuments({});
const guideSources = await db.collection('epg_sources').find({}).toArray();
const ledger = await db.collection('migration_ledger').find({}).sort({ runAt: 1 }).toArray();

const publishedChannels = channels.filter((channel) => channel.editorialStatus === 'published');
const reviewChannels = channels.filter((channel) => channel.editorialStatus === 'review');
const byCountry = {};
const byCategory = {};
for (const channel of publishedChannels) {
  byCountry[channel.country] = (byCountry[channel.country] ?? 0) + 1;
  byCategory[channel.category] = (byCategory[channel.category] ?? 0) + 1;
}

const publicSources = sources.filter(
  (source) =>
    source.editorialStatus === 'published' &&
    source.permission !== 'unlicensed' &&
    !source.conditions?.requiresForgedHeader &&
    !source.conditions?.emitterAppOnly,
);
const withheld = sources.filter((source) => source.editorialStatus !== 'published');

const inAppTypes = new Set(['hls', 'dash', 'youtube', 'official-embed']);
const publicInApp = publicSources.filter((source) => inAppTypes.has(source.type) && source.url);
const publicExternal = publicSources.filter((source) => source.type === 'external');

const channelsWithInApp = new Set(publicInApp.map((source) => source.channelId));
const channelsWithExternalOnly = new Set(
  publicExternal.map((source) => source.channelId).filter((id) => !channelsWithInApp.has(id)),
);

const withheldByReason = {};
for (const source of withheld) {
  const reason = source.permission === 'unlicensed' ? 'unlicensed' : 'withdrawn';
  withheldByReason[reason] = (withheldByReason[reason] ?? 0) + 1;
}
const inAppByType = {};
for (const source of publicInApp) inAppByType[source.type] = (inAppByType[source.type] ?? 0) + 1;

const summary = {
  generatedAt: new Date().toISOString(),
  catalogue: {
    channelsStored: channels.length,
    published: publishedChannels.length,
    inReview: reviewChannels.length,
    byCountry,
    byCategory,
  },
  sources: {
    total: sources.length,
    publiclyExposed: publicSources.length,
    publiclyExposedInApp: publicInApp.length,
    publiclyExposedExternal: publicExternal.length,
    withheld: withheld.length,
    withheldByReason,
    inAppByType,
    channelsWithInAppSource: channelsWithInApp.size,
    channelsExternalOnly: channelsWithExternalOnly.size,
  },
  guide: {
    programmes,
    sources: guideSources.map((source) => ({
      name: source.name,
      kind: source.kind,
      licence: source.licence,
      ingestionEnabled: source.ingestionEnabled,
      programmes: source.lastRunProgrammes,
    })),
  },
  migration: ledger.map((entry) => ({
    runId: entry._id,
    digest: entry.snapshotDigestSha256,
    channelRecords: entry.channelRecords,
    stats: entry.stats,
    exclusions: (entry.exclusions ?? []).length,
    exclusionsByReason: (entry.exclusions ?? []).reduce((accumulator, exclusion) => {
      accumulator[exclusion.reason] = (accumulator[exclusion.reason] ?? 0) + 1;
      return accumulator;
    }, {}),
  })),
};

mkdirSync('audits', { recursive: true });
writeFileSync('audits/data-state.json', `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
await client.close();
