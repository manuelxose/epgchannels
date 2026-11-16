/**
 * Module resolver hook for development.
 *
 * Rewrites a relative import ending in `.js` to the `.ts` file that actually
 * exists during development. It does nothing else: absolute specifiers, package
 * imports and files that already exist are left untouched.
 *
 * Registered only from `src/server/dev.ts`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return nextResolve(specifier, context);
}
