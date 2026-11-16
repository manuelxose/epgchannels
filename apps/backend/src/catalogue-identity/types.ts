/**
 * Catalogue-identity shared types.
 *
 * These are the frozen shapes for the deterministic reconciliation layer. They
 * are pure data contracts: they carry no I/O, no timestamps and no randomness.
 *
 * `SourceCandidateDoc` and the `ChannelStore` are owned by models-specialist
 * (`apps/backend/src/catalogue/`). Reconciliation only consumes the minimal
 * structural view it needs; because TypeScript is structural, the real
 * `SourceCandidateDoc` (MODULE-CONTRACT-02B §2.2) is assignable to
 * `ReconcileCandidate` without a runtime adapter.
 */

/** Minimal structural view of a source candidate consumed by `reconcile`. */
export interface ReconcileCandidate {
  name: string;
  url: string;
  /** ISO 3166-1 alpha-2, or `null` when the country is genuinely unknown. */
  country: string | null;
  /** tvg-id network/group hint, or emitter host. A hint, never identity. */
  provider: string | null;
  groupTitle: string | null;
  language: string | null;
  /** Raw `#EXTINF` attributes; `tvg-id` / `tvg-country` are read from here. */
  attributes: Record<string, string>;
}

/**
 * Structural view of an existing canonical channel, returned by
 * `ChannelStore.listIdentities()` and consumed by `reconcile`.
 *
 * `tvgIds` and `urlHosts` are optional: the current store projection returns
 * only `channelId`, `key`, `name`, `country`, `language` and `variantKey`.
 * `reconcile` treats a missing `tvgIds`/`urlHosts` as empty (never throwing),
 * so the store can start returning richer projections without a breaking change.
 */
export interface ChannelIdentityView {
  channelId: string;
  /** Stable reconciliation key (`cc:normalizedname`). */
  key: string;
  /** Display name. */
  name: string;
  /** ISO 3166-1 alpha-2, or `null`. */
  country: string | null;
  /** BCP-47 primary, projected by the store but not consumed for identity. */
  language?: string | null;
  /** Regional / local qualifier key (e.g. `es-cat`, `us-chicago`), never folded into the name. */
  variantKey: string | null;
  /** Raw `tvg-id` aliases known for this channel (absent until the store projects them). */
  tvgIds?: string[];
  /** Normalized URL hosts of known sources for this channel (absent until projected). */
  urlHosts?: string[];
}

/** Per-signal match scores, each in `0..1`. */
export interface MatchSignals {
  name: number;
  country: number;
  tvgId: number;
  urlHost: number;
}

/** Deterministic reconciliation decision. */
export interface MatchDecision {
  kind: 'same' | 'review' | 'different';
  /** Weighted score, `0..1`. */
  score: number;
  signals: MatchSignals;
  /** Proposed canonical channel, or `null` when no match is proposed. */
  channelId: string | null;
  reason: string;
}
