/**
 * localStorage wrapper that never throws: private mode, quota errors, disabled
 * storage and corrupted JSON all degrade to in-memory behaviour.
 */
export interface KeyValueStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export class SafeStorage implements KeyValueStore {
  private readonly memory = new Map<string, string>();
  private available = true;

  constructor(private readonly backend: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined) {
    if (!backend) {
      this.available = false;
      return;
    }
    try {
      const probe = '__tdt_probe__';
      backend.setItem(probe, '1');
      backend.removeItem(probe);
    } catch {
      this.available = false;
    }
  }

  read(key: string): string | null {
    if (!this.available) {
      return this.memory.get(key) ?? null;
    }
    try {
      return this.backend!.getItem(key);
    } catch {
      this.available = false;
      return this.memory.get(key) ?? null;
    }
  }

  write(key: string, value: string): void {
    this.memory.set(key, value);
    if (!this.available) {
      return;
    }
    try {
      this.backend!.setItem(key, value);
    } catch {
      this.available = false;
    }
  }

  remove(key: string): void {
    this.memory.delete(key);
    if (!this.available) {
      return;
    }
    try {
      this.backend!.removeItem(key);
    } catch {
      this.available = false;
    }
  }
}

export function browserStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readJson<T>(store: KeyValueStore, key: string, validate: (value: unknown) => T | undefined): T | undefined {
  const raw = store.read(key);
  if (raw === null) {
    return undefined;
  }
  try {
    return validate(JSON.parse(raw) as unknown);
  } catch {
    store.remove(key);
    return undefined;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.write(key, JSON.stringify(value));
  } catch {
    /* Non-serialisable values are silently dropped: preferences never break playback. */
  }
}
