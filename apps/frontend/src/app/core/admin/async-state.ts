/**
 * Ask state for the UI: one discriminated union, so a template cannot render a
 * value that was never received. `error` always carries the message the API
 * returned — the UI never substitutes placeholder data.
 */
export type AsyncState<T> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T; readonly at: number }
  | { readonly kind: 'error'; readonly message: string; readonly status: number | null };

export const idle = <T>(): AsyncState<T> => ({ kind: 'idle' });
export const loading = <T>(): AsyncState<T> => ({ kind: 'loading' });
export const ready = <T>(value: T): AsyncState<T> => ({ kind: 'ready', value, at: Date.now() });
export const errorState = <T>(message: string, status: number | null): AsyncState<T> => ({
  kind: 'error',
  message,
  status,
});

/** The loaded value, or `null` while loading/failed. */
export function valueOf<T>(state: AsyncState<T>): T | null {
  return state.kind === 'ready' ? state.value : null;
}
