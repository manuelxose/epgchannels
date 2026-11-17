/** Category and country distribution of a database, for validating an import. */
import { MongoClient } from 'mongodb';

const dbName = process.argv[2] ?? 'tdt_02fg_iptv_trial';
const client = new MongoClient('mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const db = client.db(dbName);
const channels = db.collection('channels');

const categories = await channels
  .aggregate([{ $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
  .toArray();
const countries = await channels
  .aggregate([
    { $match: { editorialStatus: 'published', mergedInto: null } },
    { $group: { _id: '$country', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 12 },
  ])
  .toArray();
const withSource = await channels.countDocuments({ editorialStatus: 'published', mergedInto: null });
const sources = await db.collection('playback_sources').countDocuments({});
const published = await db.collection('playback_sources').countDocuments({ editorialStatus: 'published' });

console.log(
  JSON.stringify(
    {
      database: dbName,
      publishedChannels: withSource,
      sources,
      publishedSources: published,
      categories: categories.map((row) => `${row._id}=${row.n}`).join(' '),
      topCountries: countries.map((row) => `${row._id}=${row.n}`).join(' '),
    },
    null,
    1,
  ),
);
await client.close();
