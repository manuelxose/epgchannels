// Cleanup: removes the probe data the manual admin walkthrough created.
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const db = client.db('tdt_platform');

const channels = await db.collection('channels').find({ slug: /^canal-de-prueba/ }).toArray();
for (const channel of channels) {
  await db.collection('playback_sources').deleteMany({ channelId: channel._id });
  await db.collection('channels').deleteOne({ _id: channel._id });
  console.log('removed probe channel:', channel.slug);
}
const audits = await db.collection('audit_log').deleteMany({});
console.log('audit entries removed (probe only):', audits.deletedCount);
const sessions = await db.collection('admin_sessions').deleteMany({});
console.log('probe sessions removed:', sessions.deletedCount);

console.log('channels now:', await db.collection('channels').countDocuments({}));
console.log('sources now:', await db.collection('playback_sources').countDocuments({}));
console.log('programmes now:', await db.collection('programmes').countDocuments({}));
await client.close();
