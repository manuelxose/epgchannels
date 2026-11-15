/**
 * Storage schemas (MongoDB documents) and their indexes.
 *
 * A document's shape is defined here once; the services never invent a field.
 * Indexes are created by the same module that owns the shape, so a fresh
 * database and a migrated one end up with identical index sets.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS } from '../infrastructure/mongo.js';

export interface ProvenanceDoc {
  source: string;
  label: string;
  url: string | null;
  licence: string;
  attribution: string | null;
  digestSha256: string | null;
  capturedAt: Date;
  editorial: boolean;
}

export interface AliasDoc {
  namespace: string;
  value: string;
}

export interface BrandingDoc {
  logoSrc: string | null;
  logoSrcPermission: 'emitter' | 'open-data' | 'explicit-permission' | 'none';
}

export interface ChannelDoc {
  _id: string;
  slug: string;
  name: string;
  shortName: string;
  country: string;
  region: { code: string; name: string } | null;
  locality: string | null;
  languageTag: string;
  category: string;
  kind: string;
  websiteUrl: string | null;
  /** Our editorial description; never third-party prose. */
  description: string;
  branding: BrandingDoc | null;
  editorialStatus: string;
  timezone: string;
  provenance: ProvenanceDoc[];
  aliases: AliasDoc[];
  /** Searchable, folded text (name + short name + aliases). */
  searchText: string;
  /** Where the channel's guide comes from, when mapped. */
  epg: { sourceId: string | null; externalId: string | null } | null;
  /** Merged-into channel, when this record was folded into another. */
  mergedInto: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Monotonic revision, incremented on every write. */
  revision: number;
}

export interface SourceConditionsDoc {
  embedAllowed: boolean;
  proxyAllowed: boolean;
  worldwide: boolean;
  restrictedRegions: string[];
  browserCompatibility: 'all' | 'desktop' | 'mobile';
  requiresForgedHeader: boolean;
  emitterAppOnly: boolean;
  notes: string | null;
}

export interface VerificationDoc {
  status: string;
  httpStatus: number | null;
  message: string | null;
  checkedAt: Date;
}

export interface PlaybackSourceDoc {
  _id: string;
  channelId: string;
  provider: string;
  type: string;
  url: string | null;
  officialPageUrl: string | null;
  permission: string;
  authorisationEvidence: string | null;
  conditions: SourceConditionsDoc;
  priority: number;
  editorialStatus: string;
  technicalStatus: string;
  lastVerifiedAt: Date | null;
  lastVerification: VerificationDoc | null;
  provenance: ProvenanceDoc[];
  createdAt: Date;
  updatedAt: Date;
  revision: number;
}

export interface ProgrammeDoc {
  _id: string;
  channelId: string;
  sourceId: string;
  title: string;
  description: string;
  genre: string | null;
  coverUrl: string | null;
  start: Date;
  end: Date;
  /** Origin identifier inside the upstream guide, for idempotent re-ingests. */
  externalKey: string;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EpgSourceDoc {
  _id: string;
  name: string;
  kind: string;
  url: string | null;
  licence: string;
  attribution: string | null;
  ingestionEnabled: boolean;
  status: string;
  lastRunAt: Date | null;
  lastRunStatus: 'never' | 'ok' | 'failed';
  lastRunProgrammes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditDoc {
  _id: string;
  actor: { type: 'user' | 'system' | 'anonymous'; id: string };
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  requestId: string;
  at: Date;
}

export interface AdminUserDoc {
  _id: string;
  email: string;
  /** scrypt hash with its parameters; never the password. */
  passwordHash: string;
  roles: string[];
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

export interface AdminSessionDoc {
  _id: string;
  userId: string;
  /** SHA-256 of the session token: the clear token is never stored. */
  tokenSha256: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface JobRunDoc {
  _id: string;
  job: string;
  status: 'ok' | 'failed';
  startedAt: Date;
  finishedAt: Date;
  message: string | null;
  details: Record<string, unknown>;
}

export interface IntegrityRefusalDoc {
  _id: string;
  runId: string;
  source: string;
  url: string | null;
  host: string | null;
  reason: string;
  at: Date;
}

/** Creates every index the queried collections need. Idempotent. */
export async function ensureIndexes(db: Db): Promise<void> {
  await db
    .collection<ChannelDoc>(COLLECTIONS.channels)
    .createIndexes([
      { key: { slug: 1 }, name: 'slug_unique', unique: true },
      { key: { editorialStatus: 1, category: 1, name: 1 }, name: 'status_category_name' },
      { key: { country: 1, 'region.code': 1, name: 1 }, name: 'country_region_name' },
      { key: { languageTag: 1, name: 1 }, name: 'language_name' },
      { key: { searchText: 'text' }, name: 'search_text', weights: { searchText: 10 } },
      { key: { 'aliases.namespace': 1, 'aliases.value': 1 }, name: 'alias_lookup' },
      { key: { updatedAt: -1 }, name: 'updated_desc' },
    ]);

  await db
    .collection<PlaybackSourceDoc>(COLLECTIONS.sources)
    .createIndexes([
      { key: { channelId: 1, priority: 1 }, name: 'channel_priority' },
      { key: { channelId: 1, editorialStatus: 1 }, name: 'channel_status' },
      { key: { technicalStatus: 1, lastVerifiedAt: -1 }, name: 'verify_queue' },
    ]);

  await db
    .collection<ProgrammeDoc>(COLLECTIONS.programmes)
    .createIndexes([
      { key: { channelId: 1, start: 1 }, name: 'channel_start' },
      { key: { channelId: 1, externalKey: 1 }, name: 'channel_external_unique', unique: true },
      { key: { end: 1 }, name: 'end_expiry' },
      { key: { sourceId: 1, start: 1 }, name: 'source_start' },
    ]);

  await db
    .collection<EpgSourceDoc>(COLLECTIONS.epgSources)
    .createIndexes([{ key: { name: 1 }, name: 'name_unique', unique: true }]);

  await db
    .collection<AuditDoc>(COLLECTIONS.audits)
    .createIndexes([
      { key: { entityType: 1, entityId: 1, at: -1 }, name: 'entity_history' },
      { key: { at: -1 }, name: 'recent' },
    ]);

  await db
    .collection<AdminUserDoc>(COLLECTIONS.admins)
    .createIndexes([{ key: { email: 1 }, name: 'email_unique', unique: true }]);

  await db
    .collection<AdminSessionDoc>(COLLECTIONS.adminSessions)
    .createIndexes([
      { key: { tokenSha256: 1 }, name: 'token_unique', unique: true },
      { key: { expiresAt: 1 }, name: 'expiry', expireAfterSeconds: 0 },
    ]);

  await db
    .collection<JobRunDoc>(COLLECTIONS.jobRuns)
    .createIndexes([{ key: { job: 1, startedAt: -1 }, name: 'job_recent' }]);

  await db
    .collection<IntegrityRefusalDoc>(COLLECTIONS.integrityRefusals)
    .createIndexes([{ key: { runId: 1 }, name: 'run' }]);
}
