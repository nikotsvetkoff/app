import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { CreateBackupDto } from './dto/create-backup.dto';
import { ImportConfigDto } from './dto/import-config.dto';
import { RestoreBackupDto } from './dto/restore-backup.dto';
import { SystemService } from './system.service';

@ApiTags('system')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('system')
export class SystemController {
  constructor(@Inject(SystemService) private readonly systemService: SystemService) {}

  @Get('health')
  health() {
    return this.systemService.getHealth();
  }

  @Get('jobs')
  jobs() {
    return this.systemService.getJobsState();
  }

  @Post('jobs/refresh-playlists')
  refreshPlaylists() {
    return this.systemService.runPlaylistRefreshJob('manual');
  }

  @Get('backups')
  listBackups() {
    return this.systemService.listBackups();
  }

  @Post('backups')
  createBackup(
    @CurrentUser() user: { sub: string; email: string },
    @Body() dto: CreateBackupDto
  ) {
    return this.systemService.runBackupJob(dto.reason ?? 'manual', {
      userId: user.sub,
      email: user.email
    });
  }

  @Post('backups/restore')
  restoreBackup(@Body() dto: RestoreBackupDto) {
    return this.systemService.restoreBackup(dto.fileName);
  }

  @Get('config/export')
  exportConfig(@CurrentUser() user: { sub: string }) {
    return this.systemService.exportConfigForUser(user.sub);
  }

  @Post('config/import')
  importConfig(@CurrentUser() user: { sub: string }, @Body() dto: ImportConfigDto) {
    return this.systemService.importConfigForUser(user.sub, dto.config, dto.replace ?? false);
  }
}
