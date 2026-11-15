/**
 * HTTP error taxonomy.
 *
 * Every thrown `AppError` becomes the documented error envelope. Anything else
 * becomes a 500 with a generic message: internal details never reach a client.
 */
import type { ApiErrorCode } from '@tdt/contracts';

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: readonly FieldIssue[],
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: readonly FieldIssue[]): AppError {
    return new AppError(400, 'bad_request', message, details);
  }
  static validation(message: string, details: readonly FieldIssue[]): AppError {
    return new AppError(400, 'validation_failed', message, details);
  }
  static notFound(message = 'Recurso no encontrado.'): AppError {
    return new AppError(404, 'not_found', message);
  }
  static unauthorized(message = 'Autenticación requerida.'): AppError {
    return new AppError(401, 'unauthorized', message);
  }
  static forbidden(message = 'Permiso insuficiente.'): AppError {
    return new AppError(403, 'forbidden', message);
  }
  static conflict(message: string): AppError {
    return new AppError(409, 'conflict', message);
  }
  static rateLimited(message = 'Demasiadas solicitudes.'): AppError {
    return new AppError(429, 'rate_limited', message);
  }
  static unavailable(message = 'Servicio no disponible.'): AppError {
    return new AppError(503, 'unavailable', message);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
