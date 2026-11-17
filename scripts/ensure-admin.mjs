/**
 * One-shot: make the administrator defined in `.env` usable in the local
 * database, hashing the password with the PRODUCT's own hasher.
 *
 * Used only when an administrator already exists and the initial sign-up is
 * therefore closed. It touches exactly one account (`ADMIN_BOOTSTRAP_EMAIL`) and
 * never prints a secret.
 */
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { hashPassword } from '../apps/backend/dist/modules/admin/admin.auth.js';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';
const DB = process.env.MONGODB_DB ?? 'tdt_platform';
const email = process.env.ADMIN_BOOTSTRAP_EMAIL;
const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

if (!email || !password) {
  console.error('ADMIN_BOOTSTRAP_EMAIL y ADMIN_BOOTSTRAP_PASSWORD son obligatorios.');
  process.exit(1);
}

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5_000 });
await client.connect();
const users = client.db(DB).collection('admin_users');
const now = new Date();
const passwordHash = await hashPassword(password);
const existing = await users.findOne({ email: email.toLowerCase() });

if (existing) {
  await users.updateOne(
    { _id: existing._id },
    { $set: { passwordHash, disabled: false, roles: ['admin'], updatedAt: now } },
  );
  console.log(JSON.stringify({ command: 'ensure-admin', account: email, action: 'password-reset' }));
} else {
  await users.insertOne({
    _id: randomUUID(),
    email: email.toLowerCase(),
    passwordHash,
    roles: ['admin'],
    disabled: false,
    createdAt: now,
  });
  console.log(JSON.stringify({ command: 'ensure-admin', account: email, action: 'created' }));
}
console.log(JSON.stringify({ activeAdmins: await users.countDocuments({ disabled: false }) }));
await client.close();
