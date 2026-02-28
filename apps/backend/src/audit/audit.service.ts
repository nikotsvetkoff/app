import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditActor {
  id?: string | null;
  email?: string | null;
}

interface AuditEntryInput {
  actor?: AuditActor | null;
  action: string;
  method?: string;
  path?: string;
  entityType?: string;
  entityId?: string | null;
  success?: boolean;
  statusCode?: number;
  details?: Record<string, unknown>;
}

export type AuditSection = 'all' | 'registration' | 'playlists' | 'devices' | 'internal';
export type AuditOutcome = 'all' | 'success' | 'error';

interface AuditListOptions {
  userId?: string;
  userEmail?: string;
  section?: AuditSection;
  outcome?: AuditOutcome;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async log(entry: AuditEntryInput): Promise<void> {
    const action = entry.action.trim();
    if (!action) {
      return;
    }

    const details = this.sanitize(entry.details ?? {});
    const data: Prisma.AuditLogCreateInput = {
      action,
      method: entry.method?.trim() || null,
      path: entry.path?.trim() || null,
      entityType: entry.entityType?.trim() || null,
      entityId: entry.entityId?.trim() || null,
      success: entry.success ?? true,
      statusCode: Number.isFinite(entry.statusCode) ? entry.statusCode : null,
      details: details as Prisma.InputJsonValue,
      userEmail: entry.actor?.email?.trim() || null,
      user:
        entry.actor?.id?.trim()
          ? {
              connect: {
                id: entry.actor.id.trim()
              }
            }
          : undefined
    };

    await this.prisma.auditLog.create({ data });
  }

  async listRecent(limit = 200, options: AuditListOptions = {}): Promise<
    Array<{
      id: string;
      action: string;
      method: string | null;
      path: string | null;
      entityType: string | null;
      entityId: string | null;
      success: boolean;
      statusCode: number | null;
      details: unknown;
      userId: string | null;
      userEmail: string | null;
      createdAt: string;
    }>
  > {
    const { userId, userEmail, section = 'all', outcome = 'all' } = options;
    const normalizedLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
    const where: Prisma.AuditLogWhereInput = {};
    const mineFilters: Prisma.AuditLogWhereInput[] = [];

    if (userId?.trim()) {
      mineFilters.push({ userId: userId.trim() });
    }
    if (userEmail?.trim()) {
      mineFilters.push({ userEmail: userEmail.trim().toLowerCase() });
    }
    if (mineFilters.length > 0) {
      where.OR = mineFilters;
    }

    if (outcome === 'success') {
      where.success = true;
    } else if (outcome === 'error') {
      where.success = false;
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: 2000
    });

    const filteredRows =
      section === 'all'
        ? rows
        : rows.filter((row) => this.resolveSection(row.path, row.entityType) === section);

    return filteredRows.slice(0, normalizedLimit).map((row) => ({
      id: row.id,
      action: row.action,
      method: row.method,
      path: row.path,
      entityType: row.entityType,
      entityId: row.entityId,
      success: row.success,
      statusCode: row.statusCode,
      details: row.details,
      userId: row.userId,
      userEmail: row.userEmail,
      createdAt: row.createdAt.toISOString()
    }));
  }

  private resolveSection(path: string | null, entityType: string | null): Exclude<AuditSection, 'all'> {
    const normalizedPath = (path ?? '').toLowerCase();
    const normalizedEntity = (entityType ?? '').toLowerCase();

    if (normalizedPath.startsWith('/auth')) {
      return 'registration';
    }

    if (normalizedPath.startsWith('/playlist') || normalizedEntity === 'playlist') {
      return 'playlists';
    }

    if (
      normalizedPath.startsWith('/devices') ||
      normalizedPath.startsWith('/device') ||
      normalizedEntity === 'devices' ||
      normalizedEntity === 'device'
    ) {
      return 'devices';
    }

    return 'internal';
  }

  private sanitize(value: unknown, depth = 0): unknown {
    if (depth > 6) {
      return '[depth-limited]';
    }

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return value.length > 400 ? `${value.slice(0, 400)}...` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 80).map((item) => this.sanitize(item, depth + 1));
    }

    if (typeof value === 'object') {
      const redacted = new Set(['password', 'token', 'authorization', 'code', 'secret']);
      const source = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(source)) {
        const keyLc = key.toLowerCase();
        if (redacted.has(keyLc)) {
          output[key] = '[redacted]';
          continue;
        }
        output[key] = this.sanitize(raw, depth + 1);
      }
      return output;
    }

    return String(value);
  }
}
