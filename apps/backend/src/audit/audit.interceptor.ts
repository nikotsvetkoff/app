import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import type { Request, Response } from 'express';
import type { RequestWithContext } from '../common/request-context';
import { AuditService } from './audit.service';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(AuditService) private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<'http'>() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithContext & Request>();
    const response = http.getResponse<Response>();
    const method = (request.method ?? '').toUpperCase();

    if (!MUTATING_METHODS.has(method)) {
      return next.handle();
    }

    const startedAt = Date.now();
    const normalizedPath = this.normalizePath(request);
    const entityType = normalizedPath.split('/').filter(Boolean)[0] ?? null;
    const entityId = typeof request.params?.id === 'string' ? request.params.id : null;
    const actor = this.resolveActor(request, normalizedPath);
    const details = {
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body ?? {}
    };

    return next.handle().pipe(
      tap((result) => {
        void this.auditService
          .log({
          actor,
          action: `${method} ${normalizedPath}`,
          method,
          path: normalizedPath,
          entityType,
          entityId,
          success: true,
          statusCode: response.statusCode,
          details: {
            ...details,
            durationMs: Date.now() - startedAt,
            result: this.summarizeResult(result)
          }
          })
          .catch(() => undefined);
      }),
      catchError((error: unknown) => {
        const statusCode =
          typeof (error as { status?: unknown })?.status === 'number'
            ? ((error as { status: number }).status ?? 500)
            : (response.statusCode || 500);

        void this.auditService
          .log({
          actor,
          action: `${method} ${normalizedPath}`,
          method,
          path: normalizedPath,
          entityType,
          entityId,
          success: false,
          statusCode,
          details: {
            ...details,
            durationMs: Date.now() - startedAt,
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message
                  }
                : { message: 'unknown error' }
          }
          })
          .catch(() => undefined);

        return throwError(() => error);
      })
    );
  }

  private resolveActor(request: RequestWithContext & Request, normalizedPath: string): { id?: string; email?: string } {
    if (request.user) {
      return {
        id: request.user.sub,
        email: request.user.email
      };
    }

    if (!normalizedPath.startsWith('/auth')) {
      return {};
    }

    const body = request.body as Record<string, unknown> | undefined;
    const query = request.query as Record<string, unknown> | undefined;
    const bodyEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const queryEmail = typeof query?.email === 'string' ? query.email.trim().toLowerCase() : '';

    if (bodyEmail) {
      return { email: bodyEmail };
    }
    if (queryEmail) {
      return { email: queryEmail };
    }

    return {};
  }

  private normalizePath(request: Request): string {
    const routePath =
      typeof request.route?.path === 'string'
        ? request.route.path
        : Array.isArray(request.route?.path)
          ? request.route.path.join('|')
          : '';
    const base = request.baseUrl ?? '';
    if (routePath) {
      return `${base}${routePath}` || '/';
    }

    const raw = request.originalUrl ?? request.url ?? '/';
    return raw.split('?')[0] || '/';
  }

  private summarizeResult(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== 'object') {
      return { value: result ?? null };
    }

    const source = result as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const key of ['success', 'id', 'message', 'status']) {
      if (key in source) {
        summary[key] = source[key];
      }
    }

    if ('accessToken' in source) {
      summary.accessToken = '[redacted]';
    }

    if (Object.keys(summary).length === 0) {
      summary.keys = Object.keys(source).slice(0, 12);
    }

    return summary;
  }
}
