/**
 * Optional cache (Valkey/Redis).
 *
 * Honest contract: the cache is an optimisation. If it is not configured, or a
 * read/write fails, callers get `null`/a no-op and the request is served from
 * the database. There is no code path where a cache outage changes an answer.
 */
import { createClient, type RedisClientType } from 'redis';

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(prefix: string): Promise<void>;
  ping(): Promise<number | null>;
  close(): Promise<void>;
  readonly enabled: boolean;
}

class NullCache implements CacheStore {
  readonly enabled = false;
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<void> {
    /* no-op */
  }
  async del(): Promise<void> {
    /* no-op */
  }
  async ping(): Promise<number | null> {
    return null;
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

export const nullCache: CacheStore = new NullCache();

class RedisCache implements CacheStore {
  readonly enabled = true;
  constructor(private readonly client: RedisClientType) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      if (ttlSeconds > 0) {
        await this.client.set(key, value, { EX: ttlSeconds });
      } else {
        await this.client.set(key, value);
      }
    } catch {
      /* the cache is optional: a failed write must not fail the request */
    }
  }

  async del(prefix: string): Promise<void> {
    try {
      for await (const key of this.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 250 })) {
        await this.client.del(key);
      }
    } catch {
      /* invalidating a cache is best effort; entries also carry a TTL */
    }
  }

  async ping(): Promise<number | null> {
    try {
      const started = performance.now();
      const reply = await this.client.ping();
      return reply === 'PONG' ? Math.round(performance.now() - started) : null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      /* already closed */
    }
  }
}

export async function connectCache(url: string | undefined): Promise<CacheStore> {
  if (!url) {
    return nullCache;
  }
  const client = createClient({
    url,
    socket: { connectTimeout: 5_000, reconnectStrategy: (retries: number) => Math.min(retries * 200, 3_000) },
  });
  client.on('error', () => {
    /* the store degrades to the database; the health endpoint reports it */
  });
  try {
    await client.connect();
  } catch {
    await client.quit().catch(() => undefined);
    return nullCache;
  }
  return new RedisCache(client as RedisClientType);
}
