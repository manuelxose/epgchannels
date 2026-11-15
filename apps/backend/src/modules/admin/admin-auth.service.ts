import { z } from 'zod';
import type { Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '../../infrastructure/mongo.js';
import { COLLECTIONS } from '../../infrastructure/mongo.js';
import type { AdminSessionDoc, AdminUserDoc, AuditDoc } from '../../infrastructure/schema.js';
import { AppError } from '../../server/errors.js';
import { sha256, canBootstrap, hashPassword, verifyPassword, createSessionToken, SESSION_TTL_MS } from './admin.auth.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(200),
});

const bootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(200),
  bootstrapToken: z.string().min(16),
  roles: z.array(z.enum(['editor', 'admin'])).min(1).default(['admin']),
});

export interface AdminPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly roles: readonly string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminPrincipal;
    }
  }
}

export class AdminAuthService {
  constructor(
    private readonly database: DatabaseHandle,
    private readonly bootstrapToken: string | undefined,
  ) {}

  private users() {
    return this.database.collection<AdminUserDoc>(COLLECTIONS.admins);
  }

  private sessions() {
    return this.database.collection<AdminSessionDoc>(COLLECTIONS.adminSessions);
  }

  private audits() {
    return this.database.collection<AuditDoc>(COLLECTIONS.audits);
  }

  /**
   * Creates the first administrator. Refused once an administrator exists, so
   * the bootstrap token cannot be replayed to add users later.
   */
  async bootstrap(input: unknown): Promise<{ email: string }> {
    const parsed = bootstrapSchema.safeParse(input);
    if (!parsed.success) {
      throw AppError.validation(
        'Datos de alta inválidos.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    if (!this.bootstrapToken) {
      throw AppError.forbidden('El alta inicial no está habilitada en este despliegue.');
    }
    if (parsed.data.bootstrapToken !== this.bootstrapToken) {
      throw AppError.unauthorized('Credencial de alta inicial incorrecta.');
    }
    const enabled = await this.users().countDocuments({ disabled: false });
    if (!canBootstrap(enabled)) {
      throw AppError.conflict('Ya existe un administrador; el alta inicial está cerrada.');
    }
    const now = new Date();
    const doc: AdminUserDoc = {
      _id: randomUUID(),
      email: parsed.data.email.toLowerCase(),
      passwordHash: await hashPassword(parsed.data.password),
      roles: parsed.data.roles,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    await this.users().insertOne(doc);
    return { email: doc.email };
  }

  async login(
    input: unknown,
    requestId: string,
  ): Promise<{ token: string; expiresAt: string; email: string }> {
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      throw AppError.validation(
        'Credenciales inválidas.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const user = await this.users().findOne({ email: parsed.data.email.toLowerCase(), disabled: false });
    // Same answer and comparable work for "no user" and "wrong password".
    const passwordOk = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
    if (!user || !passwordOk) {
      throw AppError.unauthorized('Credenciales inválidas.');
    }
    const { token, tokenSha256 } = createSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.sessions().insertOne({
      _id: randomUUID(),
      userId: user._id,
      tokenSha256,
      createdAt: now,
      expiresAt,
      revokedAt: null,
    });
    await this.users().updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
    await this.audits().insertOne({
      _id: randomUUID(),
      actor: { type: 'user', id: user.email },
      action: 'auth.login',
      entityType: 'admin-user',
      entityId: user._id,
      before: null,
      after: null,
      reason: null,
      requestId,
      at: now,
    });
    return { token, expiresAt: expiresAt.toISOString(), email: user.email };
  }

  async resolve(token: string | undefined): Promise<AdminPrincipal | null> {
    if (!token) return null;
    const session = await this.sessions().findOne({ tokenSha256: sha256(token), revokedAt: null });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    const user = await this.users().findOne({ _id: session.userId, disabled: false });
    if (!user) return null;
    return { userId: user._id, email: user.email, roles: user.roles };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.sessions().updateOne({ tokenSha256: sha256(token) }, { $set: { revokedAt: new Date() } });
  }

  /**
   * Middleware factory. `requiredRole` is `editor` for catalogue writes and
   * `admin` for guide ingestion and user management.
   */
  requireRole(requiredRole: 'editor' | 'admin'): RequestHandler {
    return (request: Request, _response: Response, next) => {
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
      this.resolve(token)
        .then((principal) => {
          if (!principal) {
            throw AppError.unauthorized('Sesión administrativa requerida.');
          }
          if (!principal.roles.includes('admin') && !principal.roles.includes(requiredRole)) {
            throw AppError.forbidden('Roles insuficientes para esta operación.');
          }
          request.admin = principal;
          next();
        })
        .catch(next);
    };
  }
}
