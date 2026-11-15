/**
 * Test harness for integration suites: a real MongoDB, a fresh database per
 * suite, and the real Express application built from the real services.
 *
 * Nothing is mocked below the HTTP layer: the tests exercise the code path a
 * deployment uses, including indexes, migrations and the publication policy.
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { MongoClient } from 'mongodb';
import type { Config } from '../config/config.js';
import { loadConfig } from '../config/config.js';
import { createApp } from '../server/app.js';
import { createContext } from '../server/bootstrap.js';
import type { AppContext } from '../server/context.js';
import { ensureIndexes } from '../infrastructure/schema.js';

export const TEST_MONGO_URI =
  process.env['TEST_MONGODB_URI'] ?? process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27117/?replicaSet=rs0';

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '4010',
    MONGODB_URI: TEST_MONGO_URI,
    MONGODB_DB: `tdt_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost:4200',
    RATE_LIMIT_MAX_REQUESTS: '100000',
    JOBS_ENABLED: 'false',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestHarness {
  readonly app: Express;
  readonly context: AppContext;
  readonly config: Config;
  readonly databaseName: string;
  close(): Promise<void>;
}

export async function createHarness(overrides: Partial<Record<string, string>> = {}): Promise<TestHarness> {
  const config = testConfig(overrides);
  const context = await createContext(config);
  await ensureIndexes(context.database.db);
  const { app } = createApp(config, context);
  const databaseName = config.MONGODB_DB;
  return {
    app,
    context,
    config,
    databaseName,
    async close() {
      await context.cache.close();
      await context.database.close();
      // Drop the throwaway database so a test run leaves no residue.
      const admin = new MongoClient(TEST_MONGO_URI);
      try {
        await admin.connect();
        await admin.db(databaseName).dropDatabase();
      } finally {
        await admin.close();
      }
    },
  };
}

/** Skips a suite with a clear message when MongoDB is not reachable. */
export async function mongoAvailable(): Promise<boolean> {
  const client = new MongoClient(TEST_MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}
