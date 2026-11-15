/**
 * Schema provenance: the ordered list of migrations this build expects.
 *
 * A migration is a named, idempotent step. The ledger records applied names, so
 * running the command twice is safe and a fresh database converges to the same
 * shape as an existing one.
 */
export interface Migration {
  readonly name: string;
  readonly description: string;
  readonly run: () => Promise<void>;
}

export const LEDGER_COLLECTION = 'migration_ledger';
