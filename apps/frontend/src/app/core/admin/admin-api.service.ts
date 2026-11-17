/**
 * The admin surface of our API, as the operator UI calls it.
 *
 * Every path here is a **real** `/api/v1/admin/...` route of the milestone base.
 * The admin routes are not in the generated SDK, so this is the one place that
 * builds their URLs; the rest of the UI only calls these methods.
 *
 * Response shapes are the published contracts (`packages/contracts/src/admin-operations.ts`),
 * imported — never redefined. A route the backend does not serve answers 404 and
 * the UI shows that error; nothing here fabricates a payload.
 */
import { Injectable, inject } from '@angular/core';
import type {
  AdminCatalogueRow,
  AdminChannelDetail,
  AdminIdentityInput,
  AdminJobRow,
  AdminMappingRow,
  AdminMetrics,
  AdminOperationError,
  AdminOverview,
  AdminSourceFailureClass,
  AdminSourceHealthRow,
  AdminSourceHistoryEntry,
  EditorialStatus,
  EpgCoverageEntry,
  EpgSyncRun,
  Permission,
  PlaybackType,
  TechnicalStatus,
  VerifySourceResult,
} from '@tdt/contracts';
import { REBUILD_CONFIG } from '../config/rebuild-config.token';
import { normalisePayload, readArray, readMember } from './json-shape';

export interface Pagination {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

/** The envelope of `/admin/epg/coverage`: the body sits under `data`. */
interface AdminCoverageEnvelope {
  readonly data?: unknown;
}

/** `/admin/epg/coverage`: `{data: {entries, totals, conflicts, asOf}}` with attribution. */
export interface EpgCoveragePayload {
  readonly entries: readonly EpgCoverageEntry[];
  readonly totals: {
    readonly channels: number;
    readonly mapped: number;
    readonly fresh: number;
    readonly stale: number;
    readonly empty: number;
    readonly notMapped: number;
  };
  readonly conflicts: number;
  readonly asOf: string;
}

/** `/admin/catalogue` — the workbench page. */
export interface CataloguePage {
  readonly data: readonly AdminCatalogueRow[];
  readonly pagination: Pagination;
}

/** `/admin/channels` (existing CRUD): the per-channel editorial payload. */
export interface ChannelSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly country: string;
  readonly category: string;
  readonly editorialStatus: EditorialStatus;
  readonly updatedAt: string;
}

export interface ChannelSummaryPage {
  readonly data: readonly ChannelSummary[];
  readonly pagination: Pagination;
}

/** One row of `/admin/sources` (existing CRUD: no URL is ever returned). */
export interface SourceRecord {
  readonly id: string;
  readonly channelId: string;
  readonly provider: string;
  readonly type: PlaybackType;
  readonly permission: Permission;
  readonly technicalStatus: TechnicalStatus;
  readonly editorialStatus: EditorialStatus;
  readonly priority: number;
  readonly lastVerifiedAt: string | null;
}

export interface SourceHealthPage {
  readonly data: readonly AdminSourceHealthRow[];
  readonly pagination: { page: number; pageSize: number; total: number };
}

export interface SourceHistory {
  readonly sourceId: string;
  readonly entries: readonly AdminSourceHistoryEntry[];
}

export interface MappingPage {
  readonly data: readonly AdminMappingRow[];
  readonly pagination: { page: number; pageSize: number; total: number };
}

export interface JobList {
  readonly data: readonly AdminJobRow[];
}

export interface OperationErrorList {
  readonly data: readonly AdminOperationError[];
}

/** An XMLTV source as the existing `/admin/epg-sources` reports it. */
export interface EpgSource {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly url: string;
  readonly licence: string;
  readonly ingestionEnabled: boolean;
  readonly status: string;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: string | null;
  readonly lastRunProgrammes: number | null;
}

export interface AdminLoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly email: string;
}

/** A failed admin call, carrying enough to tell the operator what happened. */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  /** The backend has no such route in this base. */
  get isMissing(): boolean {
    return this.status === 404;
  }
  get isUnavailable(): boolean {
    return this.status === 0 || this.status === 503;
  }
}

export function describeAdminError(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.isUnavailable) return `No se pudo contactar con la API: ${error.message}`;
    if (error.isMissing) return `La API no ofrece esta ruta en esta base (404): ${error.message}`;
    if (error.isUnauthorized) return `No se pudo autenticar (401): ${error.message}`;
    if (error.isForbidden) return `Tu cuenta no tiene el rol necesario: ${error.message}`;
    return `${error.status} · ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

type QueryValue = string | number | boolean | undefined | null;

@Injectable({ providedIn: 'root' })
export class AdminApiService {
  private readonly config = inject(REBUILD_CONFIG);

  // ---------------------------------------------------------------- auth

  login(email: string, password: string): Promise<AdminLoginResult> {
    return this.request('POST', '/auth/login', { email, password });
  }

  async logout(token: string): Promise<void> {
    await this.call('POST', '/auth/logout', undefined, token);
  }

  // ------------------------------------------------------------- overview

  overview(token: string): Promise<AdminOverview> {
    return this.request('GET', '/admin/overview', undefined, token);
  }

  // ------------------------------------------------------------ catalogue

  catalogue(
    query: {
      page?: number;
      pageSize?: number;
      q?: string;
      status?: EditorialStatus;
      country?: string;
      language?: string;
      category?: string;
    },
    token: string,
  ): Promise<CataloguePage> {
    return this.request('GET', '/admin/catalogue', undefined, token, query);
  }

  catalogueDetail(id: string, token: string): Promise<AdminChannelDetail> {
    return this.request('GET', `/admin/catalogue/${encodeURIComponent(id)}`, undefined, token);
  }

  /** Identity edit; the backend records `reason` in the audit log. */
  editIdentity(id: string, edit: AdminIdentityInput, token: string): Promise<AdminChannelDetail> {
    return this.request('POST', `/admin/catalogue/${encodeURIComponent(id)}/identity`, edit, token);
  }

  // -------------------------------------------- editorial CRUD (existing)

  listChannels(
    query: { page?: number; pageSize?: number; q?: string; status?: EditorialStatus },
    token: string,
  ): Promise<ChannelSummaryPage> {
    return this.request('GET', '/admin/channels', undefined, token, query);
  }

  listSources(query: { channelId?: string }, token: string): Promise<readonly SourceRecord[]> {
    return this.request('GET', '/admin/sources', undefined, token, query);
  }

  verifySource(id: string, token: string): Promise<VerifySourceResult> {
    return this.request('POST', `/admin/sources/${encodeURIComponent(id)}/verify`, {}, token);
  }

  withdrawSource(id: string, reason: string, token: string): Promise<{ id: string; editorialStatus: EditorialStatus }> {
    return this.request('POST', `/admin/sources/${encodeURIComponent(id)}/withdraw`, { reason }, token);
  }

  async setPriority(id: string, priority: number, reason: string, token: string): Promise<void> {
    await this.call('PATCH', `/admin/sources/${encodeURIComponent(id)}`, { priority, reason }, token);
  }

  createSource(
    input: {
      channelId: string;
      provider: string;
      type: PlaybackType;
      url: string | null;
      permission: Permission;
      conditions: {
        embedAllowed: boolean;
        proxyAllowed: boolean;
        worldwide: boolean;
        restrictedRegions: readonly string[];
        browserCompatibility: 'all' | 'desktop' | 'mobile';
        requiresForgedHeader: boolean;
        emitterAppOnly: boolean;
        notes: string | null;
      };
    },
    token: string,
  ): Promise<{ id: string; channelId: string }> {
    return this.request('POST', '/admin/sources', input, token);
  }

  // ------------------------------------------------------------ sources

  sourceHealth(
    query: {
      page?: number;
      pageSize?: number;
      channelId?: string;
      failureClass?: AdminSourceFailureClass;
      eligible?: boolean;
    },
    token: string,
  ): Promise<SourceHealthPage> {
    return this.request('GET', '/admin/sources/health', undefined, token, query);
  }

  sourceHistory(id: string, token: string): Promise<SourceHistory> {
    return this.request('GET', `/admin/sources/${encodeURIComponent(id)}/history`, undefined, token);
  }

  // ---------------------------------------------------------------- EPG

  epgSources(token: string): Promise<readonly EpgSource[]> {
    return this.request('GET', '/admin/epg-sources', undefined, token);
  }

  async epgCoverage(token: string): Promise<EpgCoveragePayload> {
    /*
     * The endpoint answers {data: {entries, totals, conflicts, asOf}, attribution},
     * so callJson keeps the object and the body is read from its data member.
     */
    const payload = await this.request<AdminCoverageEnvelope>('GET', '/admin/epg/coverage', undefined, token);
    const body = readMember(payload, 'data') ?? payload;
    return {
      entries: readArray<EpgCoverageEntry>(readMember(body, 'entries')) ?? [],
      totals: (readMember(body, 'totals') ?? {}) as EpgCoveragePayload['totals'],
      conflicts: Number(readMember(body, 'conflicts') ?? 0),
      asOf: String(readMember(body, 'asOf') ?? ''),
    };
  }

  epgMappings(query: { page?: number; pageSize?: number }, token: string): Promise<MappingPage> {
    return this.request('GET', '/admin/epg/mappings', undefined, token, query);
  }

  ingestionRuns(token: string): Promise<readonly EpgSyncRun[]> {
    return this.request('GET', '/admin/epg/ingestion-runs', undefined, token);
  }

  /** Manual ingestion of one XMLTV source (`requireAdmin`). */
  ingest(sourceId: string, token: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/admin/epg/ingest', { sourceId }, token);
  }

  confirmMapping(id: string, reason: string, token: string): Promise<unknown> {
    return this.request('POST', `/admin/epg/mappings/${encodeURIComponent(id)}/confirm`, { reason }, token);
  }

  rejectMapping(id: string, reason: string, token: string): Promise<unknown> {
    return this.request('POST', `/admin/epg/mappings/${encodeURIComponent(id)}/reject`, { reason }, token);
  }

  // ---------------------------------------------------------- operations

  jobs(token: string): Promise<JobList> {
    return this.request('GET', '/admin/operations/jobs', undefined, token);
  }

  pauseJob(name: string, reason: string, token: string): Promise<unknown> {
    return this.request('POST', `/admin/operations/jobs/${encodeURIComponent(name)}/pause`, { reason }, token);
  }

  resumeJob(name: string, reason: string, token: string): Promise<unknown> {
    return this.request('POST', `/admin/operations/jobs/${encodeURIComponent(name)}/resume`, { reason }, token);
  }

  operationErrors(token: string): Promise<OperationErrorList> {
    return this.request('GET', '/admin/operations/errors', undefined, token);
  }

  metrics(token: string): Promise<AdminMetrics> {
    return this.request('GET', '/admin/operations/metrics', undefined, token);
  }

  // ------------------------------------------------------------------ http

  /**
   * One request, with the envelope unwrapped. A response whose `data` is a list
   * becomes a plain array; everything else is the `data` object itself.
   */
  /** The payload of one request; the error envelope is handled by call. */
  private request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    token?: string,
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    return this.callJson(method, path, body, token, query) as Promise<T>;
  }

  private async call(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    token?: string,
    query?: Record<string, QueryValue>,
  ): Promise<Response> {
    const base = this.config.apiBaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}${path}`, globalThis.location?.origin ?? 'http://localhost');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['authorization'] = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
      });
    } catch (error) {
      throw new AdminApiError(0, error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw new AdminApiError(response.status, await errorMessage(response));
    return response;
  }

  private async callJson(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    token?: string,
    query?: Record<string, QueryValue>,
  ): Promise<unknown> {
    const response = await this.call(method, path, body, token, query);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      const out = normalisePayload(parsed);
      return out;
    } catch {
      throw new AdminApiError(response.status, 'La API respondió algo que no es JSON.');
    }
  }
}

/** The API sends `{ error: { code, message }, requestId }`. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return response.statusText || `HTTP ${response.status}`;
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const inner = parsed.error;
    if (inner && typeof inner === 'object' && typeof inner.message === 'string') return inner.message;
    if (typeof inner === 'string') return inner;
    if (typeof parsed.message === 'string') return parsed.message;
    return text.slice(0, 300);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}
