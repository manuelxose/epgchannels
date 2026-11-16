/**
 * Ingestion — formats, bounded snapshots and provenance (MODULE-CONTRACT-02B §3.1).
 *
 * Pure modules only: no network, no clock beyond the snapshot's `retrievedAt`,
 * no database. Persisting candidates belongs to `catalogue/`.
 */
export * from './m3u.js';
export * from './snapshot.js';
export * from './provenance.js';
export * from './metrics.js';
