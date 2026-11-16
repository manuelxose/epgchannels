/**
 * Development entry point.
 *
 * `npm run dev` must not depend on a build step, but the source imports use
 * `.js` specifiers (required to emit ES modules for Node). Node's built-in type
 * stripping refuses to resolve those to `.ts` files, so this entry registers a
 * tiny resolver hook that does exactly that — and nothing else.
 *
 * Why a hook and not a bundler: the alternative is adding tsx or ts-node to the
 * runtime dependencies of the platform for a development-only concern. The hook
 * is ~30 lines, runs only under `--import`, and never touches production code
 * (`npm start` runs the compiled `dist/`).
 *
 * The heavy lifting is delegated to `src/server/main.ts`; this file only makes
 * the module graph resolvable in development.
 */
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);

await import('./main.js');
