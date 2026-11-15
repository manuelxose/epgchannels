/**
 * Administrative contracts (`/api/v1/admin/*`).
 *
 * Every mutation is validated here and recorded in the audit log by the
 * service layer. The admin surface is never reachable with a key shipped to a
 * browser: it uses bearer credentials that are hashed at rest.
 */
import { z } from 'zod';
import {
  aliasSchema,
  channelCategorySchema,
  channelKindSchema,
  countryCodeSchema,
  editorialStatusSchema,
  idSchema,
  isoTimestampSchema,
  localeCodeSchema,
  paginationSchema,
  playbackTypeSchema,
  permissionSchema,
  slugSchema,
  technicalStatusSchema,
  timezoneSchema,
} from './common.js';
import { channelSchema, regionSchema } from './channels.js';

/** Fields an editor may set on a channel, shared by create and update. */
const mutableChannelFields = {
  name: z.string().trim().min(1).max(160),
  shortName: z.string().trim().min(1).max(40),
  country: countryCodeSchema,
  region: regionSchema.nullable(),
  locality: z.string().trim().min(1).max(120).nullable(),
  language: localeCodeSchema,
  category: channelCategorySchema,
  kind: channelKindSchema,
  websiteUrl: z.string().url().nullable(),
  /** Our editorial description. Never a third-party text. */
  description: z.string().max(2000),
  timezone: timezoneSchema,
  branding: z
    .object({
      logoSrc: z.string().url().nullable(),
      logoSrcPermission: z.enum(['emitter', 'open-data', 'explicit-permission', 'none']),
    })
    .nullable(),
  aliases: z.array(aliasSchema).max(50),
};
type MutableChannelField = keyof typeof mutableChannelFields;

/** Every mutable field is optional on create; typed explicitly, not inferred. */
const optionalChannelFields = Object.fromEntries(
  (Object.keys(mutableChannelFields) as MutableChannelField[]).map((key) => [
    key,
    mutableChannelFields[key].optional(),
  ]),
) as unknown as { [K in MutableChannelField]: z.ZodOptional<(typeof mutableChannelFields)[K]> };

export interface CreateChannelInput {
  readonly name: string;
  readonly shortName?: string;
  readonly slug?: string;
  readonly country: string;
  readonly region?: { readonly code: string; readonly name: string } | null;
  readonly locality?: string | null;
  readonly language?: string;
  readonly category: z.infer<typeof channelCategorySchema>;
  readonly kind?: z.infer<typeof channelKindSchema>;
  readonly websiteUrl?: string | null;
  readonly description?: string;
  readonly timezone?: string;
  readonly branding?: z.infer<(typeof mutableChannelFields)['branding']>;
  readonly aliases?: readonly z.infer<typeof aliasSchema>[];
  readonly editorialStatus?: z.infer<typeof editorialStatusSchema>;
  readonly provenance: ReadonlyArray<{
    readonly source: string;
    readonly label: string;
    readonly url: string | null;
    readonly licence: string;
    readonly attribution: string | null;
    readonly editorial: boolean;
  }>;
  /** Free-form reference to the source record for this creation, if any. */
  readonly externalRef?: string;
}

export const createChannelInputSchema = z.object({
  ...optionalChannelFields,
  name: mutableChannelFields.name,
  country: mutableChannelFields.country,
  category: mutableChannelFields.category,
  /** Optional slug. When omitted it is derived from `name`; a collision is 409. */
  slug: slugSchema.optional(),
  editorialStatus: editorialStatusSchema.optional(),
  /** Provenance is mandatory: no record can be created anonymously. */
  provenance: z
    .array(
      z.object({
        source: z.string().min(1).max(120),
        label: z.string().min(1).max(300),
        url: z.string().url().nullable(),
        licence: z.string().min(1).max(80),
        attribution: z.string().max(600).nullable(),
        editorial: z.boolean(),
      }),
    )
    .min(1),
  externalRef: z.string().max(200).optional(),
}) as unknown as z.ZodType<CreateChannelInput, z.ZodTypeDef, unknown>;

export interface UpdateChannelInput {
  readonly name?: string;
  readonly shortName?: string;
  readonly slug?: string;
  readonly country?: string;
  readonly region?: { readonly code: string; readonly name: string } | null;
  readonly locality?: string | null;
  readonly language?: string;
  readonly category?: z.infer<typeof channelCategorySchema>;
  readonly kind?: z.infer<typeof channelKindSchema>;
  readonly websiteUrl?: string | null;
  readonly description?: string;
  readonly timezone?: string;
  readonly branding?: z.infer<(typeof mutableChannelFields)['branding']>;
  readonly aliases?: readonly z.infer<typeof aliasSchema>[];
  readonly editorialStatus?: z.infer<typeof editorialStatusSchema>;
  /** Optimistic concurrency: must equal the record's current `updatedAt`. */
  readonly expectedUpdatedAt?: string;
  /** Reason recorded in the audit entry. */
  readonly reason?: string;
}

export const updateChannelInputSchema = z
  .object({
    ...optionalChannelFields,
    name: mutableChannelFields.name.optional(),
    country: mutableChannelFields.country.optional(),
    category: mutableChannelFields.category.optional(),
    slug: slugSchema.optional(),
    editorialStatus: editorialStatusSchema.optional(),
    expectedUpdatedAt: isoTimestampSchema.optional(),
    reason: z.string().max(400).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty update' }) as unknown as z.ZodType<
  UpdateChannelInput,
  z.ZodTypeDef,
  unknown
>;

export const mergeChannelInputSchema = z.object({
  /** The duplicate folded into `:id`. */
  duplicateId: idSchema,
  reason: z.string().trim().min(3).max(400),
});
export type MergeChannelInput = z.infer<typeof mergeChannelInputSchema>;

const conditionsSchema = z.object({
  /** May this source be embedded in our own UI? */
  embedAllowed: z.boolean(),
  /** May it be proxied by a server-side segment? */
  proxyAllowed: z.boolean(),
  /** May it be shown from any country we serve? */
  worldwide: z.boolean(),
  /** Regions where the emitter restricts it (ISO 3166-1 alpha-2). */
  restrictedRegions: z.array(countryCodeSchema).max(250),
  /** Browsers that can reproduce it. */
  browserCompatibility: z.enum(['all', 'desktop', 'mobile']),
  /** True when a Referer/User-Agent/credential would be required (never forged). */
  requiresForgedHeader: z.boolean(),
  /** True when the emitter only allows its own registered application. */
  emitterAppOnly: z.boolean(),
  /** Free editorial note shown as the source label; optional. */
  notes: z.string().max(600).nullable().default(null),
});

export type SourceConditionsInput = z.infer<typeof conditionsSchema>;

export interface CreateSourceInput {
  readonly channelId: string;
  readonly provider: string;
  readonly type: z.infer<typeof playbackTypeSchema>;
  readonly url: string | null;
  readonly officialPageUrl?: string | null;
  readonly permission: z.infer<typeof permissionSchema>;
  readonly authorisationEvidence?: string | null;
  readonly conditions: SourceConditionsInput;
  readonly priority?: number;
  readonly editorialStatus?: z.infer<typeof editorialStatusSchema>;
}

export const createSourceInputSchema = z.object({
  channelId: idSchema,
  /** Who publishes the stream: the emitter itself, YouTube, a CDN… */
  provider: z.string().min(1).max(80),
  type: playbackTypeSchema,
  /** Public media URL, or the official player page. */
  url: z.string().url().nullable(),
  /** Official page of the emitter (required for `external`). */
  officialPageUrl: z.string().url().nullable().optional(),
  /** Why we may expose it. A source without permission cannot be published. */
  permission: permissionSchema,
  /** Pointer to the evidence kept outside the repository. */
  authorisationEvidence: z.string().max(600).nullable().optional(),
  conditions: conditionsSchema,
  priority: z.number().int().min(0).max(1000).optional(),
  editorialStatus: editorialStatusSchema.optional(),
}) as unknown as z.ZodType<CreateSourceInput, z.ZodTypeDef, unknown>;

export interface UpdateSourceInput {
  readonly provider?: string;
  readonly url?: string | null;
  readonly officialPageUrl?: string | null;
  readonly permission?: z.infer<typeof permissionSchema>;
  readonly authorisationEvidence?: string | null;
  readonly conditions?: Partial<SourceConditionsInput>;
  readonly priority?: number;
  readonly editorialStatus?: z.infer<typeof editorialStatusSchema>;
  readonly technicalStatus?: z.infer<typeof technicalStatusSchema>;
  readonly expectedUpdatedAt?: string;
  readonly reason?: string;
}

export const updateSourceInputSchema = z
  .object({
    provider: z.string().min(1).max(80).optional(),
    url: z.string().url().nullable().optional(),
    officialPageUrl: z.string().url().nullable().optional(),
    permission: permissionSchema.optional(),
    authorisationEvidence: z.string().max(600).nullable().optional(),
    conditions: conditionsSchema.partial().optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    editorialStatus: editorialStatusSchema.optional(),
    technicalStatus: technicalStatusSchema.optional(),
    expectedUpdatedAt: isoTimestampSchema.optional(),
    reason: z.string().max(400).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'empty update' }) as unknown as z.ZodType<
  UpdateSourceInput,
  z.ZodTypeDef,
  unknown
>;

/** Result of verifying one source on demand. */
export const verifySourceResultSchema = z.object({
  sourceId: idSchema,
  status: technicalStatusSchema,
  httpStatus: z.number().int().nullable(),
  checkedAt: isoTimestampSchema,
  message: z.string().nullable(),
});
export type VerifySourceResult = z.infer<typeof verifySourceResultSchema>;

export const adminSourceRecordSchema = z.object({
  id: idSchema,
  provider: z.string(),
  type: playbackTypeSchema,
  url: z.string().url().nullable(),
  permission: permissionSchema,
  technicalStatus: technicalStatusSchema,
  editorialStatus: editorialStatusSchema,
  priority: z.number().int(),
  lastVerifiedAt: isoTimestampSchema.nullable(),
  /** Whether the public API would expose it right now, and why not. */
  publiclyExposed: z.boolean(),
  exclusionReason: z.string().nullable(),
});

/** Admin channel payload: the public record plus editorial-only fields. */
export const adminChannelSchema = channelSchema.extend({
  timezone: timezoneSchema,
  sourceRecords: z.array(adminSourceRecordSchema),
  issues: z.array(
    z.object({ kind: z.enum(['verification', 'policy']), code: z.string(), message: z.string(), observedAt: z.string().nullable() }),
  ),
});
export type AdminChannel = z.infer<typeof adminChannelSchema>;

export const adminChannelResponseSchema = z.object({ data: adminChannelSchema });

export const auditEntrySchema = z.object({
  id: idSchema,
  actor: z.object({ type: z.enum(['user', 'system', 'anonymous']), id: z.string() }),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  reason: z.string().nullable(),
  requestId: z.string(),
  at: isoTimestampSchema,
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListResponseSchema = z.object({
  data: z.array(auditEntrySchema),
  pagination: paginationSchema,
});

export interface AuditListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly action?: string | undefined;
}

export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(80).optional(),
  action: z.string().max(80).optional(),
}) as unknown as z.ZodType<AuditListQuery, z.ZodTypeDef, unknown>;

/** Admin: the provider adapters the platform knows how to use. */
export const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  types: z.array(playbackTypeSchema),
  requirements: z.array(z.string()),
  credentialFree: z.boolean(),
  enabled: z.boolean(),
  description: z.string(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerListResponseSchema = z.object({ data: z.array(providerSchema) });

/** Revert a record to a recorded revision. */
export const revertInputSchema = z.object({ auditId: idSchema });
