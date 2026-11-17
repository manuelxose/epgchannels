/**
 * Small helpers over the JSON the API returns.
 *
 * A JSON response is read once, at the boundary, into ordinary values: objects
 * become own-property records and arrays become plain arrays. Everything after
 * that point (signals, templates, `map`) works on data the language can iterate
 * normally — no response object ever reaches a component.
 */

/**
 * A named member read **only** from the value's own properties, so it never
 * resolves an inherited member such as `Object.prototype.constructor`.
 */
export function readMember(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
  return descriptor ? (descriptor.value as unknown) : undefined;
}

/** `true` when `value` is a JSON list (a `length` own property). */
export function isJsonArray(value: unknown): boolean {
  return typeof readMember(value, 'length') === 'number';
}

/** The own keys of a JSON object or list, in their original order. */
export function ownKeys(value: unknown): readonly string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.getOwnPropertyNames(value as object);
}

/** A plain array copy of `value`, or `null` when it is not a JSON list. */
export function readArray<T>(value: unknown): readonly T[] | null {
  const length = readMember(value, 'length');
  if (typeof length !== 'number') return null;
  const out: T[] = [];
  for (let index = 0; index < length; index += 1) {
    out.push(readMember(value, String(index)) as T);
  }
  return out;
}

/** A plain record copy of a JSON object (arrays and scalars are passed through). */
export function readObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || isJsonArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of ownKeys(value)) {
    out[key] = readMember(value, key);
  }
  return out;
}

/** The `data` member of the API envelope, or the payload itself when it has none. */
export function envelopeData(payload: unknown): unknown {
  return ownKeys(payload).includes('data') ? readMember(payload, 'data') : payload;
}

/**
 * Normalises a whole API payload.
 *
 * The envelope is unwrapped **only when `data` is all there is** — the common
 * `{data: [...]}` form. A payload that also carries `pagination` keeps its
 * `data` member, because unwrapping it would discard the page descriptor the
 * catalogue page must display. In both cases every member is copied to an
 * ordinary value, so no response object reaches a component.
 */
export function normalisePayload(payload: unknown): unknown {
  const keys = ownKeys(payload);
  const onlyData = keys.length === 1 && keys[0] === 'data';
  if (onlyData) {
    const data = readMember(payload, 'data');
    return readArray<unknown>(data) ?? readObject(data);
  }
  return readObject(payload);
}
