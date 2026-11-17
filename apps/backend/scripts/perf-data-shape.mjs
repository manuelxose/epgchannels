// Read-only snapshot of the live catalogue axes that Part G must integrate with.
const { createRequire } = await import('node:module');
const { resolve } = await import('node:path');
const ROOT = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(ROOT, 'apps/backend/package.json'));
const { MongoClient } = require('mongodb');

const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const db = client.db(process.env.MONGODB_DB ?? 'tdt_platform');
const published = { editorialStatus: 'published', mergedInto: null };

const group = async (field) =>
  db
    .collection('channels')
    .aggregate([{ $match: published }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .toArray();

const report = {
  country: await group('country'),
  languageTag: await group('languageTag'),
  regional: await group('region'),
  publishedWithEpgSource: await db.collection('channels').countDocuments({ ...published, 'epg.sourceId': { $ne: null } }),
  programmes: await db.collection('programmes').estimatedDocumentCount(),
  programmesMaxStart: (
    await db.collection('programmes').find({}, { projection: { start: 1 } }).sort({ start: -1 }).limit(1).toArray()
  )[0]?.start ?? null,
  programmesMinStart: (
    await db.collection('programmes').find({}, { projection: { start: 1 } }).sort({ start: 1 }).limit(1).toArray()
  )[0]?.start ?? null,
  distinctProgrammeChannels: (await db.collection('programmes').distinct('channelId')).length,
  sources: await db.collection('playback_sources').estimatedDocumentCount(),
  authorizations: await db.collection('source_authorizations_02c').estimatedDocumentCount(),
};
await client.close();
console.log(JSON.stringify(report, null, 2));
