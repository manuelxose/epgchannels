/**
 * Copies the operational database into a disposable one, for a bounded trial
 * import before touching production data. Credentials and audit are not copied.
 *
 *   node scripts/copy-database.mjs <source> <target>
 */
import { MongoClient } from 'mongodb';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('uso: node scripts/copy-database.mjs <origen> <destino>');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0');
await client.connect();
const from = client.db(source);
const to = client.db(target);
await to.dropDatabase();
const skipped = new Set(['admin_users', 'admin_sessions', 'audit_log']);
const copied = [];
for (const { name } of await from.listCollections().toArray()) {
  if (skipped.has(name)) continue;
  await from.collection(name).aggregate([{ $out: { db: target, coll: name } }]).toArray();
  copied.push(name);
}
console.log(JSON.stringify({ command: 'copy-database', from: source, to: target, collections: copied.length }));
await client.close();
