/**
 * Development entry point.
 *
 * `npm run dev` must not depend on a build step, but the source imports use
 * `.js` specifiers (required to emit ES modules for Node). Node's built-in type
 * stripping refuses to resolve those to `.ts` files, so this entry registers a
 * tiny resolver hook that does exactly that — and nothing else.
 *
 * The hook must be registered before the first project import, so the logic
 * below is a single dynamic import inside a function: a static import here
 * would be resolved before `register()` runs.
 *
 * Why a hook and not a bundler: the alternative is adding tsx or ts-node to the
 * runtime dependencies of the platform for a development-only concern. The hook
 * runs only under `--import`, and never touches production (`npm start` runs the
 * compiled `dist/`).
 */
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);

async function boot(): Promise<void> {
  const { explainListenError } = await import('./listen-errors.js');
  /*
   * A port already in use reaches Node as an unhandled 'error' event with a
   * stack trace that names a syscall and no cause. Turn the one error a
   * developer will really hit into a sentence with a next step.
   */
  const port = Number(process.env['PORT'] ?? 4010);
  const host = process.env['HOST'] ?? '127.0.0.1';
  process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
    const explanation = explainListenError(error, port, host);
    if (explanation) {
      process.stderr.write(`\n${explanation}\n\n`);
      process.exit(1);
    }
    throw error;
  });
  await import('./main.js');
}

await boot();
