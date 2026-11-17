/**
 * Catalogue workbench state: page, filters and the selected channel detail.
 *
 * Signals only, no subscriptions. A failed call becomes `error` with the API's own
 * message; the store never substitutes fabricated rows.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  AdminCatalogueRow,
  AdminChannelDetail,
  ChannelCategory,
  EditorialStatus,
  PlaybackType,
  Permission,
} from '@tdt/contracts';
import { AdminApiError, AdminApiService, describeAdminError, type Pagination } from './admin-api.service';
import { readArray, readMember } from './json-shape';
import { AdminSessionStore } from './admin-session.store';
import { errorState, idle, loading, ready, type AsyncState } from './async-state';

export interface CatalogueFilters {
  readonly q: string;
  readonly status: EditorialStatus | '';
  readonly country: string;
  readonly language: string;
  readonly category: ChannelCategory | '';
  readonly page: number;
  readonly pageSize: number;
}

const INITIAL_FILTERS: CatalogueFilters = {
  q: '',
  status: '',
  country: '',
  language: '',
  category: '',
  page: 1,
  pageSize: 25,
};

export interface IdentityEdit {
  readonly name: string;
  readonly shortName: string;
  readonly country: string;
  readonly language: string;
  readonly category: ChannelCategory;
  readonly regionCode: string | null;
  readonly reason: string;
}

@Injectable({ providedIn: 'root' })
export class AdminCatalogueStore {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionStore);

  private readonly filtersState = signal<CatalogueFilters>(INITIAL_FILTERS);
  private readonly listState = signal<AsyncState<readonly AdminCatalogueRow[]>>(idle());
  private readonly paginationState = signal<Pagination | null>(null);
  private readonly detailState = signal<AsyncState<AdminChannelDetail>>(idle());
  private readonly historyState = signal<AsyncState<string>>(idle());
  private readonly actionState = signal<AsyncState<string>>(idle());
  private sequence = 0;

  readonly filters = this.filtersState;
  private readonly rowsState = signal<readonly AdminCatalogueRow[]>([]);
  readonly rows = this.rowsState;
  readonly status = computed(() => this.listState().kind);
  readonly error = computed(() => {
    const state = this.listState();
    return state.kind === 'error' ? state.message : null;
  });
  readonly pagination = this.paginationState;

  readonly detail = computed(() => {
    const state = this.detailState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly detailStatus = computed(() => this.detailState().kind);
  readonly detailError = computed(() => {
    const state = this.detailState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly sourceHistory = computed(() => {
    const state = this.historyState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly historyError = computed(() => {
    const state = this.historyState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly lastAction = computed(() => {
    const state = this.actionState();
    return state.kind === 'ready' ? state.value : null;
  });
  readonly lastActionError = computed(() => {
    const state = this.actionState();
    return state.kind === 'error' ? state.message : null;
  });

  async load(): Promise<void> {
    const token = this.session.token();
    if (!token) {
      this.rowsState.set([]);
      this.listState.set(errorState('Inicia sesión para consultar el catálogo.', 401));
      return;
    }
    const request = ++this.sequence;
    const { q, status, country, language, category, page, pageSize } = this.filtersState();
    this.listState.set(loading());
    try {
      const result = await this.api.catalogue(
        {
          page,
          pageSize,
          ...(q ? { q } : {}),
          ...(status ? { status } : {}),
          ...(country ? { country } : {}),
          ...(language ? { language } : {}),
          ...(category ? { category } : {}),
        },
        token,
      );
      if (request !== this.sequence) return;
      const rows = readArray<AdminCatalogueRow>(readMember(result, 'data')) ?? [];
      this.listState.set(ready(rows));
      this.rowsState.set(rows);
      this.paginationState.set(readPage(result));
    } catch (error) {
      if (request !== this.sequence) return;
      this.rowsState.set([]);
      this.listState.set(errorState(describeAdminError(error), statusOf(error)));
      this.paginationState.set(null);
    }
  }

  async setFilters(patch: Partial<CatalogueFilters>): Promise<void> {
    // Anything but a page change starts again from page 1.
    const resetPage = Object.keys(patch).some((key) => key !== 'page');
    this.filtersState.update((current) => ({ ...current, ...patch, ...(resetPage ? { page: 1 } : {}) }));
    await this.load();
  }

  async open(channelId: string): Promise<void> {
    const token = this.session.token();
    if (!token) return;
    this.detailState.set(loading());
    this.historyState.set(idle());
    this.actionState.set(idle());
    try {
      this.detailState.set(ready(await this.api.catalogueDetail(channelId, token)));
    } catch (error) {
      this.detailState.set(errorState(describeAdminError(error), statusOf(error)));
    }
  }

  close(): void {
    this.detailState.set(idle());
    this.historyState.set(idle());
    this.actionState.set(idle());
  }

  /** Saves identity; on success the API's own updated detail replaces the view. */
  async saveIdentity(channelId: string, edit: IdentityEdit): Promise<boolean> {
    const token = this.session.token();
    if (!token) return false;
    if (edit.reason.trim().length < 3) {
      this.actionState.set(errorState('Indica un motivo de al menos 3 caracteres: queda en la auditoría.', null));
      return false;
    }
    this.actionState.set(loading());
    try {
      const updated = await this.api.editIdentity(channelId, { ...edit, reason: edit.reason.trim() }, token);
      this.detailState.set(ready(updated));
      this.actionState.set(ready('Identidad guardada y registrada en la auditoría.'));
      await this.load();
      return true;
    } catch (error) {
      this.actionState.set(errorState(describeAdminError(error), statusOf(error)));
      return false;
    }
  }

  /** Runs the real verification; the reported status is the API's answer. */
  async verifySource(sourceId: string): Promise<void> {
    const token = this.session.token();
    if (!token) return;
    this.actionState.set(loading());
    try {
      const result = await this.api.verifySource(sourceId, token);
      this.actionState.set(
        ready(
          `Verificación ${result.sourceId}: ${result.status}` +
            (result.httpStatus ? ` · HTTP ${result.httpStatus}` : '') +
            (result.message ? ` · ${result.message}` : ''),
        ),
      );
      const detail = this.detail();
      if (detail) await this.open(detail.id);
    } catch (error) {
      this.actionState.set(errorState(describeAdminError(error), statusOf(error)));
    }
  }

  /** The verification ring the backend keeps for one source. */
  async loadHistory(sourceId: string): Promise<void> {
    const token = this.session.token();
    if (!token) return;
    this.historyState.set(loading());
    try {
      const history = await this.api.sourceHistory(sourceId, token);
      const lines = history.entries
        .map(
          (entry) =>
            `${entry.at} · ${entry.state}/${entry.depth}` +
            (entry.httpStatus ? ` · HTTP ${entry.httpStatus}` : '') +
            ` · ${entry.failureClass}` +
            (entry.detail ? ` · ${entry.detail}` : ''),
        )
        .join('\n');
      this.historyState.set(ready(lines || 'Sin verificaciones registradas para esta fuente.'));
    } catch (error) {
      this.historyState.set(errorState(describeAdminError(error), statusOf(error)));
    }
  }

  async setPriority(sourceId: string, priority: number, reason: string): Promise<boolean> {
    const token = this.session.token();
    if (!token) return false;
    this.actionState.set(loading());
    try {
      await this.api.setPriority(sourceId, priority, reason, token);
      this.actionState.set(ready(`Prioridad actualizada a ${priority}.`));
      const detail = this.detail();
      if (detail) await this.open(detail.id);
      return true;
    } catch (error) {
      this.actionState.set(errorState(describeAdminError(error), statusOf(error)));
      return false;
    }
  }

  async withdrawSource(sourceId: string, reason: string): Promise<boolean> {
    const token = this.session.token();
    if (!token) return false;
    if (reason.trim().length < 3) {
      this.actionState.set(errorState('Indica un motivo de al menos 3 caracteres para retirar la fuente.', null));
      return false;
    }
    this.actionState.set(loading());
    try {
      const result = await this.api.withdrawSource(sourceId, reason.trim(), token);
      this.actionState.set(ready(`Fuente retirada. Estado editorial: ${result.editorialStatus}.`));
      const detail = this.detail();
      if (detail) await this.open(detail.id);
      return true;
    } catch (error) {
      this.actionState.set(errorState(describeAdminError(error), statusOf(error)));
      return false;
    }
  }

  /** Registers a new source through the existing `POST /admin/sources`. */
  async addSource(input: {
    channelId: string;
    provider: string;
    type: PlaybackType;
    url: string;
    permission: Permission;
  }): Promise<boolean> {
    const token = this.session.token();
    if (!token) return false;
    this.actionState.set(loading());
    try {
      await this.api.createSource(
        {
          channelId: input.channelId,
          provider: input.provider,
          type: input.type,
          url: input.url,
          permission: input.permission,
          // Conservative defaults: nothing is assumed to be embeddable or proxiable
          // until an operator says so on the source record itself.
          conditions: {
            embedAllowed: false,
            proxyAllowed: false,
            worldwide: true,
            restrictedRegions: [],
            browserCompatibility: 'all',
            requiresForgedHeader: false,
            emitterAppOnly: false,
            notes: null,
          },
        },
        token,
      );
      this.actionState.set(ready('Fuente registrada. Queda pendiente de verificación y revisión editorial.'));
      const detail = this.detail();
      if (detail) await this.open(detail.id);
      return true;
    } catch (error) {
      this.actionState.set(errorState(describeAdminError(error), statusOf(error)));
      return false;
    }
  }
}

function statusOf(error: unknown): number | null {
  return error instanceof AdminApiError ? error.status : null;
}

/**
 * The page descriptor of a catalogue payload.
 *
 * Members are read by name (`readMember`) so a response without `pagination`
 * simply yields `null` instead of borrowing an inherited member.
 */
function readPage(payload: unknown): Pagination | null {
  const page = readMember(payload, 'pagination');
  if (!page) return null;
  const numbers = new Map<string, unknown>();
  for (const key of ['page', 'pageSize', 'total', 'pageCount']) numbers.set(key, readMember(page, key));
  const flags = new Map<string, unknown>();
  for (const key of ['hasNext', 'hasPrevious']) flags.set(key, readMember(page, key));
  return {
    page: numbers.get('page') as number,
    pageSize: numbers.get('pageSize') as number,
    total: numbers.get('total') as number,
    pageCount: numbers.get('pageCount') as number,
    hasNext: flags.get('hasNext') as boolean,
    hasPrevious: flags.get('hasPrevious') as boolean,
  };
}