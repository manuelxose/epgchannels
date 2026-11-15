/**
 * Structured logging. One JSON object per line, with the fields an operator
 * needs to correlate a request, and without request bodies or secrets.
 */
import { pino, type Logger } from 'pino';
import type { Config } from '../config/config.js';

export type { Logger };

/** Paths whose payload is never logged, even at trace level. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'tdt-backend', env: config.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

/** A logger that discards everything, for unit tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
