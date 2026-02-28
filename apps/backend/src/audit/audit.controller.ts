import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { AuditOutcome, AuditSection, AuditService } from './audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('audit')
export class AuditController {
  constructor(@Inject(AuditService) private readonly auditService: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: { sub: string; email: string },
    @Query('limit') rawLimit?: string,
    @Query('scope') scope?: 'mine' | 'all',
    @Query('section') section?: AuditSection,
    @Query('outcome') outcome?: AuditOutcome
  ) {
    const limit = Number.parseInt(rawLimit ?? '200', 10);
    const normalizedScope = scope === 'mine' ? 'mine' : 'all';
    const normalizedSection: AuditSection =
      section === 'registration' || section === 'playlists' || section === 'devices' || section === 'internal'
        ? section
        : 'all';
    const normalizedOutcome: AuditOutcome = outcome === 'success' || outcome === 'error' ? outcome : 'all';

    return this.auditService.listRecent(limit, {
      userId: normalizedScope === 'mine' ? user.sub : undefined,
      userEmail: normalizedScope === 'mine' ? user.email : undefined,
      section: normalizedSection,
      outcome: normalizedOutcome
    });
  }
}
