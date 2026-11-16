/**
 * Bounded, versioned snapshot loader with per-file digest verification.
 *
 * A snapshot is a directory written by the maintainer tooling
 * (`maintainers/fetch-snapshots.mjs`): a `manifest.json`
 * (`tdt-snapshot-manifest/1`) plus the upstream playlist files it describes.
 * Ingestion only ever reads such snapshots — there is no network path here.
 *
 * Guarantees:
 * - every listed file is read inside the snapshot root (no traversal), bounded
 *   in size, and its SHA-256 must equal the manifest entry;
 * - the total bytes read must equal the manifest total: a partially copied
 *   snapshot is rejected;
 * - one mismatch or missing file makes `integrity === 'failed'` and yields no
 *   playlists — a tampered or partial snapshot is never partially accepted.
 *
 * The parser is bounded too: a file above {@link MAX_FILE_BYTES} or with more
 * than {@link MAX_ENTRIES} entries fails the snapshot instead of being cut.
 *
 * It does not: fetch, repair, rewrite or trust a manifest without checking it,
 * and it does not create the `SourceSnapshotDoc` (see {@link snapshotDocument}).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { MAX_LINE_CHARS, parseM3u, type M3uPlaylist } from './m3u.js';
import type { SourceSnapshotDoc, SourceSnapshotLicence } from './provenance.js';

export const SNAPSHOT_MANIFEST_VERSION = 'tdt-snapshot-manifest/1';
/** Upstream sources this loader understands. */
export const SNAPSHOT_UPSTREAMS = ['iptv-org', 'free-tv'] as const;
export type SnapshotUpstream = (typeof SNAPSHOT_UPSTREAMS)[number];

/** A single playlist file above this size is rejected (bounded). */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Total snapshot bytes above this are rejected (bounded). */
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
/** More files than this, or more entries in one file, is rejected (bounded). */
export const MAX_FILES = 1_000;
export const MAX_ENTRIES = 50_000;

export interface SnapshotManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  entries: number;
}

export interface SnapshotManifest {
  upstream: SnapshotUpstream;
  commitSha: string | null;
  /** ISO-8601. */
  retrievedAt: string;
  files: SnapshotManifestFile[];
  licence: SourceSnapshotLicence;
  /** Manifest schema version actually found. */
  schemaVersion: string;
  repo: string | null;
  upstreamUrl: string | null;
  /** Totals declared by the manifest, when present. */
  declared: { fileCount: number | null; entryCount: number | null; bytes: number | null; truncated: boolean };
}

export interface LoadedPlaylist {
  /** Path relative to the snapshot root, POSIX separators. */
  path: string;
  /** Digest actually computed from the bytes on disk (equal to the manifest's). */
  sha256: string;
  bytes: number;
  playlist: M3uPlaylist;
}

export type SnapshotIntegrity = 'ok' | 'failed';

export interface SnapshotLoadResult {
  manifest: SnapshotManifest | null;
  playlists: LoadedPlaylist[];
  integrity: SnapshotIntegrity;
  /** Every integrity problem found, in file order. Empty when `integrity === 'ok'`. */
  errors: string[];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parses and validates a manifest object. Returns a typed error instead of throwing. */
export function parseManifest(raw: unknown): { manifest: SnapshotManifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { manifest: null, errors: ['manifest: not a JSON object'] };
  const schemaVersion = typeof raw['schemaVersion'] === 'string' ? raw['schemaVersion'] : '';
  if (schemaVersion !== SNAPSHOT_MANIFEST_VERSION) {
    errors.push(`manifest: unsupported schemaVersion ${JSON.stringify(schemaVersion)}`);
  }
  const upstream = raw['upstream'];
  if (typeof upstream !== 'string' || !(SNAPSHOT_UPSTREAMS as readonly string[]).includes(upstream)) {
    errors.push(`manifest: unknown upstream ${JSON.stringify(upstream)}`);
  }
  const commitSha = raw['commitSha'];
  if (commitSha !== null && commitSha !== undefined && !(typeof commitSha === 'string' && /^[a-f0-9]{7,64}$/i.test(commitSha))) {
    errors.push('manifest: commitSha is not a hex commit id');
  }
  const retrievedAtRaw = raw['retrievedAt'];
  const retrievedAt = typeof retrievedAtRaw === 'string' ? new Date(retrievedAtRaw) : null;
  if (retrievedAt === null || Number.isNaN(retrievedAt.getTime())) errors.push('manifest: retrievedAt is not an ISO date');

  const licenceRaw = raw['licence'];
  const licence = isRecord(licenceRaw) ? parseLicence(licenceRaw) : null;
  if (licence === null) errors.push('manifest: licence missing or malformed');

  const filesRaw = raw['files'];
  const files: SnapshotManifestFile[] = [];
  if (!Array.isArray(filesRaw)) {
    errors.push('manifest: files is not an array');
  } else if (filesRaw.length > MAX_FILES) {
    errors.push(`manifest: ${filesRaw.length} files exceeds the bound of ${MAX_FILES}`);
  } else {
    const seen = new Set<string>();
    for (const [index, item] of filesRaw.entries()) {
      if (!isRecord(item)) {
        errors.push(`manifest: files[${index}] is not an object`);
        continue;
      }
      const path = item['path'];
      const sha256 = item['sha256'];
      const bytes = asInt(item['bytes']);
      const entries = asInt(item['entries']);
      if (typeof path !== 'string' || path === '' || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
        errors.push(`manifest: files[${index}].path is not a safe relative POSIX path`);
        continue;
      }
      if (seen.has(path)) {
        errors.push(`manifest: duplicate file path ${path}`);
        continue;
      }
      if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256.toLowerCase())) {
        errors.push(`manifest: files[${index}].sha256 is not a sha256 hex digest`);
        continue;
      }
      if (bytes === null) {
        errors.push(`manifest: files[${index}].bytes is not a non-negative integer`);
        continue;
      }
      if (entries === null) {
        errors.push(`manifest: files[${index}].entries is not a non-negative integer`);
        continue;
      }
      seen.add(path);
      files.push({ path, sha256: sha256.toLowerCase(), bytes, entries });
    }
  }

  if (errors.length > 0 || licence === null || retrievedAt === null) {
    return { manifest: null, errors };
  }
  const manifest: SnapshotManifest = {
    upstream: upstream as SnapshotUpstream,
    commitSha: typeof commitSha === 'string' ? commitSha : null,
    retrievedAt: retrievedAt.toISOString(),
    files,
    licence,
    schemaVersion,
    repo: typeof raw['repo'] === 'string' ? raw['repo'] : null,
    upstreamUrl: typeof raw['upstreamUrl'] === 'string' ? raw['upstreamUrl'] : null,
    declared: {
      fileCount: asInt(raw['fileCount']),
      entryCount: asInt(raw['entryCount']),
      bytes: asInt(raw['bytes']),
      truncated: raw['truncated'] === true,
    },
  };
  return { manifest, errors: [] };
}

function parseLicence(raw: Record<string, unknown>): SourceSnapshotLicence | null {
  const reuse = raw['reuse'];
  if (reuse !== 'public-domain' && reuse !== 'permitted-with-attribution' && reuse !== 'unlicensed') return null;
  const spdx = raw['spdx'];
  const url = raw['url'];
  const notes = raw['notes'];
  return {
    spdx: typeof spdx === 'string' ? spdx : null,
    url: typeof url === 'string' ? url : null,
    reuse,
    notes: typeof notes === 'string' ? notes : '',
  };
}

function within(root: string, relative: string): string | null {
  const absolute = resolve(root, ...relative.split('/'));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return absolute.startsWith(prefix) ? absolute : null;
}

/**
 * Reads `manifest.json`, then every listed file, verifying size and SHA-256.
 *
 * Never throws: filesystem and parse failures become entries in `errors` with
 * `integrity: 'failed'`. On failure `playlists` is empty — callers must not
 * ingest a partially verified snapshot.
 */
export function loadSnapshot(root: string): SnapshotLoadResult {
  const errors: string[] = [];
  const absoluteRoot = resolve(root);
  let manifestText: string;
  try {
    manifestText = readFileSync(resolve(absoluteRoot, 'manifest.json'), 'utf8');
  } catch (error) {
    return { manifest: null, playlists: [], integrity: 'failed', errors: [`manifest: unreadable (${describeError(error)})`] };
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestText);
  } catch (error) {
    return { manifest: null, playlists: [], integrity: 'failed', errors: [`manifest: invalid JSON (${describeError(error)})`] };
  }
  const parsed = parseManifest(rawManifest);
  if (parsed.manifest === null) {
    return { manifest: null, playlists: [], integrity: 'failed', errors: parsed.errors };
  }
  const manifest = parsed.manifest;
  if (manifest.files.length === 0) {
    return { manifest, playlists: [], integrity: 'failed', errors: ['manifest: no files listed'] };
  }
  if (manifest.declared.fileCount !== null && manifest.declared.fileCount !== manifest.files.length) {
    errors.push(`manifest: fileCount ${manifest.declared.fileCount} ≠ ${manifest.files.length} listed files`);
  }
  if (manifest.declared.bytes !== null) {
    const listed = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    if (listed !== manifest.declared.bytes) errors.push(`manifest: declared bytes ${manifest.declared.bytes} ≠ sum of files ${listed}`);
  }

  let totalBytes = 0;
  let totalEntries = 0;
  const playlists: LoadedPlaylist[] = [];
  for (const file of manifest.files) {
    const absolute = within(absoluteRoot, file.path);
    if (absolute === null) {
      errors.push(`${file.path}: escapes the snapshot root`);
      continue;
    }
    if (file.bytes > MAX_FILE_BYTES) {
      errors.push(`${file.path}: ${file.bytes} bytes exceeds the bound of ${MAX_FILE_BYTES}`);
      continue;
    }
    let bytes: Buffer;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) {
        errors.push(`${file.path}: not a regular file`);
        continue;
      }
      bytes = readFileSync(absolute);
    } catch (error) {
      errors.push(`${file.path}: unreadable (${describeError(error)})`);
      continue;
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      errors.push(`snapshot: total bytes exceed the bound of ${MAX_SNAPSHOT_BYTES}`);
      break;
    }
    if (bytes.length !== file.bytes) {
      errors.push(`${file.path}: size ${bytes.length} ≠ manifest ${file.bytes}`);
      continue;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256) {
      errors.push(`${file.path}: sha256 ${digest} ≠ manifest ${file.sha256}`);
      continue;
    }
    const playlist = parseM3u(bytes);
    if (playlist.entries.length > MAX_ENTRIES) {
      errors.push(`${file.path}: ${playlist.entries.length} entries exceeds the bound of ${MAX_ENTRIES}`);
      continue;
    }
    const longest = longestLine(bytes);
    if (longest > MAX_LINE_CHARS) {
      errors.push(`${file.path}: a line of ${longest} chars exceeds the bound of ${MAX_LINE_CHARS}`);
      continue;
    }
    totalEntries += playlist.entries.length;
    if (file.entries > 0 && playlist.entries.length !== file.entries) {
      errors.push(`${file.path}: parsed ${playlist.entries.length} entries ≠ manifest ${file.entries}`);
      continue;
    }
    playlists.push({ path: file.path, sha256: digest, bytes: bytes.length, playlist });
  }

  if (manifest.declared.entryCount !== null && totalEntries !== manifest.declared.entryCount && errors.length === 0) {
    errors.push(`manifest: declared entries ${manifest.declared.entryCount} ≠ parsed ${totalEntries}`);
  }
  if (errors.length > 0) {
    return { manifest, playlists: [], integrity: 'failed', errors };
  }
  return { manifest, playlists, integrity: 'ok', errors: [] };
}

function longestLine(bytes: Uint8Array): number {
  // Cheap bound check on bytes, before decoding: any line longer than the bound
  // will also be longer as text for every encoding we accept (UTF-16 halves it).
  let longest = 0;
  let current = 0;
  const limit = Math.max(MAX_LINE_CHARS * 2, 4096);
  for (const byte of bytes) {
    if (byte === 0x0a) {
      if (current > longest) longest = current;
      current = 0;
      if (longest > limit) return longest;
    } else {
      current += 1;
    }
  }
  return Math.max(longest, current);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Builds the `SourceSnapshotDoc` for a verified snapshot.
 *
 * `_id` is the snapshot checksum: the same bytes always describe the same
 * snapshot. A failed load yields a `rejected` document with the first error as
 * `rejectionReason`. It does not write the document anywhere.
 */
export function snapshotDocument(
  load: SnapshotLoadResult,
  options: { upstreamUrl?: string | null; now?: Date; fallbackUpstream?: SnapshotUpstream } = {},
): SourceSnapshotDoc {
  const now = options.now ?? new Date();
  const manifest = load.manifest;
  const accepted = load.integrity === 'ok' && manifest !== null;
  const checksum =
    accepted && manifest.files.length > 0
      ? createHash('sha256')
          .update(manifest.files.map((file) => `${file.path}:${file.sha256}`).join('\n'), 'utf8')
          .update(`\n${manifest.commitSha ?? ''}\n${manifest.retrievedAt}`, 'utf8')
          .digest('hex')
      : createHash('sha256').update(load.errors.join('\n') || 'empty', 'utf8').digest('hex');
  const retrievedAt = manifest === null ? now : new Date(manifest.retrievedAt);
  return {
    _id: checksum,
    upstream: manifest?.upstream ?? options.fallbackUpstream ?? 'iptv-org',
    upstreamUrl: options.upstreamUrl ?? manifest?.upstreamUrl ?? (manifest?.repo !== null && manifest?.repo !== undefined ? `https://github.com/${manifest.repo}` : ''),
    commitSha: manifest?.commitSha ?? null,
    retrievedAt,
    checksumSha256: checksum,
    licence: manifest?.licence ?? { spdx: null, url: null, reuse: 'unlicensed', notes: 'manifest unreadable' },
    format: 'm3u',
    fileCount: load.playlists.length,
    entryCount: load.playlists.reduce((sum, playlist) => sum + playlist.playlist.entries.length, 0),
    bytes: load.playlists.reduce((sum, playlist) => sum + playlist.bytes, 0),
    status: accepted ? 'ingested' : 'rejected',
    rejectionReason: accepted ? null : (load.errors[0] ?? 'snapshot integrity failed'),
    createdAt: now,
  };
}
