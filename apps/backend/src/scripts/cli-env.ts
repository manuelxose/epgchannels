/**
 * CLI entry points share this loader: it reads `.env` (if present), validates
 * the configuration and gives every script the same fatal error shape.
 */
import { moduleDirectory, loadDotEnv } from '../config/config.js';

export interface CliEnv {
  readonly loadedDotEnv: boolean;
}

let initialised = false;

/** Idempotent: scripts import and call this once before `loadConfig()`. */
export function initCliEnvironment(): CliEnv {
  if (!initialised) {
    loadDotEnv(moduleDirectory());
    initialised = true;
  }
  return { loadedDotEnv: true };
}

export function reportFailure(command: string, error: unknown): void {
  console.error(
    JSON.stringify({
      command,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}
