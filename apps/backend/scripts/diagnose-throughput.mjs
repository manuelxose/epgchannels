// Diagnose where the throughput ceiling comes from.
import { MongoClient } from 'mongodb';

const base = 'http://127.0.0.1:4010/api/v1';

// 1. Redis hit/miss ratio during the load test.
const { execSync } = await import('node:child_process');
console.log('redis stats:');
console.log(
  execSync('docker exec tdt-api01-redis redis-cli -p 27118 info stats', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((line) => /keyspace_hits|keyspace_misses|total_commands/.test(line))
    .join('\n'),
);

// 2. Direct MongoDB timing for the list query, without Express in the way.
const client = new MongoClient('mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const db = client.db('tdt_platform');
const probes = [
  ['find page 1', () => db.collection('channels').find({ editorialStatus: 'published', mergedInto: null }).sort({ name: 1 }).skip(0).limit(24).toArray()],
  ['count', () => db.collection('channels').countDocuments({ editorialStatus: 'published', mergedInto: null })],
  ['find+count', async () => {
    await Promise.all([
      db.collection('channels').find({ editorialStatus: 'published', mergedInto: null }).sort({ name: 1 }).skip(0).limit(24).toArray(),
      db.collection('channels').countDocuments({ editorialStatus: 'published', mergedInto: null }),
    ]);
  }],
  ['sources $in', async () => {
    const docs = await db.collection('channels').find({ editorialStatus: 'published' }).limit(24).toArray();
    await db.collection('playback_sources').find({ channelId: { $in: docs.map((d) => d._id) } }).toArray();
  }],
  ['aggregate full catalogue', () => db.collection('channels').find({ editorialStatus: 'published', mergedInto: null }).toArray()],
];
for (const [label, run] of probes) {
  const times = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  console.log(label.padEnd(26), times.map((time) => Math.round(time)).join(' '));
}

// 3. HTTP single-request timing, sequential, with keep-alive.
for (const path of ['/channels?page=1&pageSize=24', '/categories']) {
  const times = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`);
    await response.arrayBuffer();
    times.push(performance.now() - started);
  }
  console.log('http', path.padEnd(30), times.map((time) => Math.round(time)).join(' '));
}

await client.close();
