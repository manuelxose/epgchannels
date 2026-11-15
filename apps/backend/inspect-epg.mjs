// Inspection: why does a channel with programmes report an empty schedule?
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const db = client.db('tdt_platform');

const channel = await db.collection('channels').findOne({ slug: 'la-1' }, { projection: { _id: 1, name: 1, epg: 1, aliases: 1 } });
console.log('channel:', JSON.stringify(channel));
console.log('programmes total:', await db.collection('programmes').countDocuments({}));

const sample = await db.collection('programmes').find({}).limit(3).toArray();
console.log(
  'sample:',
  JSON.stringify(
    sample.map((s) => ({
      channelId: s.channelId,
      start: s.start,
      end: s.end,
      title: s.title.slice(0, 30),
      externalKey: s.externalKey.slice(0, 60),
    })),
    null,
    1,
  ),
);

if (channel) {
  console.log('programmes for la-1:', await db.collection('programmes').countDocuments({ channelId: channel._id }));
}

const starts = await db.collection('programmes').find({}).limit(1).toArray();
if (starts[0]) console.log('typeof start:', typeof starts[0].start, starts[0].start instanceof Date, String(starts[0].start));

const byChannel = await db
  .collection('programmes')
  .aggregate([{ $group: { _id: '$channelId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 3 }])
  .toArray();
console.log('top channels by programmes:', JSON.stringify(byChannel));

const withProgrammes = await db
  .collection('channels')
  .findOne({ _id: byChannel[0]?._id }, { projection: { slug: 1, name: 1, epg: 1 } });
console.log('one such channel:', JSON.stringify(withProgrammes));

await client.close();
