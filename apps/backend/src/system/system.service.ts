import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import path from 'path';
import { assertSafeHttpUrl } from '../common/url-safety.util';
import { PlaylistService } from '../playlist/playlist.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemStateService } from './system-state.service';

interface BackupPayload {
  version: number;
  createdAt: string;
  reason: string;
  actor: {
    userId: string | null;
    email: string | null;
  };
  data: Record<string, unknown[]>;
}

interface ImportConfigShape {
  version: number;
  basePlaylists: Array<{ name: string; url: string }>;
  customPlaylists: Array<{
    name: string;
    channelIds: string[];
    sourcePlaylistNames: string[];
    isActive: boolean;
  }>;
  clients: Array<{
    firstName: string;
    lastName: string;
    phone: string;
    address: string;
    devicesAllowed: number;
    sourcePlaylistNames: string[];
  }>;
  activeCustomPlaylistName: string | null;
}

type JobTrigger = 'manual' | 'auto';

@Injectable()
export class SystemService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemService.name);
  private readonly backupDir: string;
  private readonly backupRetentionDays: number;
  private readonly automationEnabled: boolean;
  private readonly playlistRefreshIntervalSec: number;
  private readonly autoBackupIntervalSec: number;
  private playlistRefreshTimer: NodeJS.Timeout | null = null;
  private backupTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PlaylistService) private readonly playlistService: PlaylistService,
    @Inject(SystemStateService) private readonly state: SystemStateService,
    @Inject(ConfigService) configService: ConfigService
  ) {
    this.backupDir = path.resolve(
      process.cwd(),
      String(configService.get('SYSTEM_BACKUP_DIR') ?? 'data/backups')
    );
    this.backupRetentionDays = Math.max(
      1,
      Number(configService.get('SYSTEM_BACKUP_RETENTION_DAYS') ?? 14)
    );
    this.automationEnabled =
      String(configService.get('SYSTEM_AUTOMATION_ENABLED') ?? 'true')
        .trim()
        .toLowerCase() === 'true';
    this.playlistRefreshIntervalSec = Math.max(
      60,
      Number(configService.get('SYSTEM_PLAYLIST_REFRESH_INTERVAL_SEC') ?? 1800)
    );
    this.autoBackupIntervalSec = Math.max(
      300,
      Number(configService.get('SYSTEM_AUTO_BACKUP_INTERVAL_SEC') ?? 21600)
    );
  }

  onModuleInit(): void {
    if (!this.automationEnabled) {
      this.logger.log('System automation is disabled by config');
      return;
    }

    this.playlistRefreshTimer = setInterval(() => {
      void this.runPlaylistRefreshJob('auto');
    }, this.playlistRefreshIntervalSec * 1000);
    this.playlistRefreshTimer.unref?.();

    this.backupTimer = setInterval(() => {
      void this.runBackupJob('auto-scheduled');
    }, this.autoBackupIntervalSec * 1000);
    this.backupTimer.unref?.();

    this.logger.log(
      `System automation enabled: playlist_refresh=${this.playlistRefreshIntervalSec}s, auto_backup=${this.autoBackupIntervalSec}s`
    );
  }

  onModuleDestroy(): void {
    if (this.playlistRefreshTimer) {
      clearInterval(this.playlistRefreshTimer);
      this.playlistRefreshTimer = null;
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  }

  async getHealth() {
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbError: string | null = null;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      dbStatus = 'error';
      dbError = error instanceof Error ? error.message : 'unknown db error';
    }

    const jobs = this.state.snapshot();
    const alerts: string[] = [];
    if (jobs.playlistRefresh.consecutiveFailures >= 3) {
      alerts.push('playlist_auto_refresh_has_repeated_failures');
    }
    if (jobs.backup.consecutiveFailures >= 2) {
      alerts.push('backup_has_repeated_failures');
    }

    return {
      status: dbStatus === 'ok' && alerts.length === 0 ? 'ok' : 'degraded',
      now: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      db: {
        status: dbStatus,
        error: dbError
      },
      jobs,
      alerts
    };
  }

  getJobsState() {
    return this.state.snapshot();
  }

  async runPlaylistRefreshJob(trigger: JobTrigger = 'manual') {
    const current = this.state.snapshot();
    if (current.playlistRefresh.inProgress) {
      return {
        success: true,
        skipped: true,
        reason: 'playlist_refresh_already_running',
        trigger,
        startedAt: current.playlistRefresh.lastRunAt
      };
    }

    const startedAt = Date.now();
    this.state.markPlaylistRefreshStart();

    try {
      const users = await this.prisma.user.findMany({
        select: {
          id: true,
          email: true,
          basePlaylists: {
            select: {
              id: true,
              name: true
            },
            orderBy: [{ createdAt: 'asc' }, { name: 'asc' }]
          }
        }
      });

      let usersWithSources = 0;
      let refreshedSources = 0;
      const errors: Array<{
        userId: string;
        email: string;
        sourceId: string;
        sourceName: string;
        error: string;
      }> = [];

      for (const user of users) {
        if (!user.basePlaylists.length) {
          continue;
        }
        usersWithSources += 1;

        for (const source of user.basePlaylists) {
          try {
            await this.playlistService.refreshBasePlaylistForUser(user.id, source.id);
            refreshedSources += 1;
          } catch (error) {
            errors.push({
              userId: user.id,
              email: user.email,
              sourceId: source.id,
              sourceName: source.name,
              error: error instanceof Error ? error.message : 'unknown error'
            });
          }
        }
      }

      const summary = {
        trigger,
        finishedAt: new Date().toISOString(),
        usersCount: users.length,
        usersWithSources,
        refreshedSources,
        failedSources: errors.length,
        errors: errors.slice(0, 30)
      };

      this.state.markPlaylistRefreshSuccess(summary, Date.now() - startedAt);
      return {
        success: errors.length === 0,
        ...summary
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'playlist refresh failed';
      this.state.markPlaylistRefreshFailure(message, Date.now() - startedAt);
      throw error;
    }
  }

  async runBackupJob(reason: string, actor?: { userId?: string; email?: string }) {
    const current = this.state.snapshot();
    if (current.backup.inProgress) {
      return {
        success: true,
        skipped: true,
        reason: 'backup_already_running',
        startedAt: current.backup.lastRunAt
      };
    }

    return this.createBackup(reason, actor);
  }

  async listBackups(): Promise<
    Array<{
      fileName: string;
      sizeBytes: number;
      modifiedAt: string;
    }>
  > {
    await this.ensureBackupDir();

    const entries = await fs.readdir(this.backupDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(async (entry) => {
          const fullPath = path.join(this.backupDir, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            fileName: entry.name,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString()
          };
        })
    );

    return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async createBackup(reason: string, actor?: { userId?: string; email?: string }) {
    const startedAt = Date.now();
    const normalizedReason = this.normalizeBackupReason(reason);
    this.state.markBackupStart();

    try {
      await this.ensureBackupDir();
      const payload = await this.collectFullBackupPayload(normalizedReason, actor);
      const fileName = this.buildBackupFileName(normalizedReason);
      const fullPath = path.join(this.backupDir, fileName);
      const json = JSON.stringify(payload, null, 2);
      await fs.writeFile(fullPath, json, 'utf8');
      await this.cleanupExpiredBackups();

      const summary = {
        fileName,
        path: fullPath,
        sizeBytes: Buffer.byteLength(json, 'utf8'),
        createdAt: payload.createdAt
      };

      this.state.markBackupSuccess(summary, Date.now() - startedAt);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'backup failed';
      this.state.markBackupFailure(message, Date.now() - startedAt);
      throw error;
    }
  }

  async restoreBackup(fileName: string) {
    const startedAt = Date.now();
    this.state.markBackupStart();
    try {
      const safeFileName = this.normalizeBackupFileName(fileName);
      await this.ensureBackupDir();
      const fullPath = path.join(this.backupDir, safeFileName);
      const raw = await fs.readFile(fullPath, 'utf8');
      const payload = JSON.parse(raw) as BackupPayload;
      await this.restorePayload(payload);

      const summary = {
        fileName: safeFileName,
        restoredAt: new Date().toISOString()
      };
      this.state.markBackupSuccess(summary, Date.now() - startedAt);
      return {
        success: true,
        ...summary
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'restore failed';
      this.state.markBackupFailure(message, Date.now() - startedAt);
      throw error;
    }
  }

  async exportConfigForUser(userId: string) {
    const [basePlaylists, customPlaylists, clients, sourceSettings] = await Promise.all([
      this.prisma.basePlaylist.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, url: true }
      }),
      this.prisma.customPlaylist.findMany({
        where: { userId },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          channelIds: true,
          sourcePlaylistIds: true
        }
      }),
      this.prisma.client.findMany({
        where: { userId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          address: true,
          devicesAllowed: true,
          sourcePlaylistIds: true
        }
      }),
      this.prisma.playlistSource.findUnique({
        where: { userId },
        select: {
          activeCustomPlaylistId: true
        }
      })
    ]);

    const baseNameById = new Map(basePlaylists.map((row) => [row.id, row.name] as const));
    const activeCustomName =
      customPlaylists.find((playlist) => playlist.id === sourceSettings?.activeCustomPlaylistId)
        ?.name ?? null;

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      activeCustomPlaylistName: activeCustomName,
      basePlaylists: basePlaylists.map((playlist) => ({
        name: playlist.name,
        url: playlist.url
      })),
      customPlaylists: customPlaylists.map((playlist) => ({
        name: playlist.name,
        channelIds: this.asStringArray(playlist.channelIds),
        sourcePlaylistNames: this.asStringArray(playlist.sourcePlaylistIds)
          .map((id) => baseNameById.get(id))
          .filter((name): name is string => Boolean(name)),
        isActive: playlist.id === sourceSettings?.activeCustomPlaylistId
      })),
      clients: clients.map((client) => ({
        firstName: client.firstName,
        lastName: client.lastName,
        phone: client.phone,
        address: client.address,
        devicesAllowed: client.devicesAllowed,
        sourcePlaylistNames: this.asStringArray(client.sourcePlaylistIds)
          .map((id) => baseNameById.get(id))
          .filter((name): name is string => Boolean(name))
      }))
    };
  }

  async importConfigForUser(userId: string, rawConfig: Record<string, unknown>, replace = false) {
    const config = this.normalizeImportConfig(rawConfig);

    const summary = await this.prisma.$transaction(async (transaction) => {
      if (replace) {
        await transaction.device.updateMany({
          where: { userId },
          data: {
            clientId: null,
            playlistMode: 'GLOBAL',
            customPlaylistId: null
          }
        });
        await transaction.client.deleteMany({ where: { userId } });
        await transaction.basePlaylistCache.deleteMany({
          where: { basePlaylist: { userId } }
        });
        await transaction.basePlaylist.deleteMany({ where: { userId } });
        await transaction.customPlaylist.deleteMany({ where: { userId } });
        await transaction.playlistSource.deleteMany({ where: { userId } });
        await transaction.playlistCache.deleteMany({ where: { userId } });
      }

      const existingBaseRows = await transaction.basePlaylist.findMany({
        where: { userId },
        select: { id: true, name: true, url: true }
      });
      const existingBaseNames = new Set(existingBaseRows.map((row) => row.name.toLowerCase()));
      const existingBaseUrls = new Set(existingBaseRows.map((row) => row.url.toLowerCase()));

      let createdBase = 0;
      for (const playlist of config.basePlaylists) {
        const nameLc = playlist.name.toLowerCase();
        const urlLc = playlist.url.toLowerCase();
        if (!replace && (existingBaseNames.has(nameLc) || existingBaseUrls.has(urlLc))) {
          continue;
        }

        await transaction.basePlaylist.create({
          data: {
            userId,
            name: playlist.name,
            url: playlist.url
          }
        });
        createdBase += 1;
        existingBaseNames.add(nameLc);
        existingBaseUrls.add(urlLc);
      }

      const allBaseRows = await transaction.basePlaylist.findMany({
        where: { userId },
        select: { id: true, name: true },
        orderBy: [{ createdAt: 'asc' }]
      });
      const baseIdByName = new Map(allBaseRows.map((row) => [row.name.toLowerCase(), row.id] as const));

      const existingCustomNames = new Set(
        (
          await transaction.customPlaylist.findMany({
            where: { userId },
            select: { name: true }
          })
        ).map((row) => row.name.toLowerCase())
      );

      let createdCustom = 0;
      let activeCustomId: string | null = null;
      for (const playlist of config.customPlaylists) {
        const nameLc = playlist.name.toLowerCase();
        if (!replace && existingCustomNames.has(nameLc)) {
          if (playlist.isActive && !activeCustomId) {
            const existing = await transaction.customPlaylist.findFirst({
              where: { userId, name: playlist.name },
              select: { id: true }
            });
            activeCustomId = existing?.id ?? activeCustomId;
          }
          continue;
        }

        const sourcePlaylistIds = playlist.sourcePlaylistNames
          .map((sourceName) => baseIdByName.get(sourceName.toLowerCase()))
          .filter((id): id is string => Boolean(id));

        const created = await transaction.customPlaylist.create({
          data: {
            userId,
            name: playlist.name,
            channelIds: playlist.channelIds as unknown as Prisma.InputJsonValue,
            sourcePlaylistIds: sourcePlaylistIds as unknown as Prisma.InputJsonValue
          },
          select: {
            id: true
          }
        });

        createdCustom += 1;
        existingCustomNames.add(nameLc);
        if (playlist.isActive || playlist.name === config.activeCustomPlaylistName) {
          activeCustomId = created.id;
        }
      }

      if (activeCustomId) {
        await transaction.playlistSource.upsert({
          where: { userId },
          update: {
            activeCustomPlaylistId: activeCustomId
          },
          create: {
            userId,
            url: '',
            activeCustomPlaylistId: activeCustomId
          }
        });
      }

      const existingClientPhones = new Set(
        (
          await transaction.client.findMany({
            where: { userId },
            select: { phone: true }
          })
        ).map((row) => row.phone.trim())
      );

      let createdClients = 0;
      for (const client of config.clients) {
        const phone = client.phone.trim();
        if (!replace && existingClientPhones.has(phone)) {
          continue;
        }
        const sourcePlaylistIds = client.sourcePlaylistNames
          .map((sourceName) => baseIdByName.get(sourceName.toLowerCase()))
          .filter((id): id is string => Boolean(id));

        await transaction.client.create({
          data: {
            userId,
            firstName: client.firstName,
            lastName: client.lastName,
            phone,
            address: client.address,
            devicesAllowed: client.devicesAllowed,
            sourcePlaylistIds: sourcePlaylistIds as unknown as Prisma.InputJsonValue
          }
        });
        createdClients += 1;
        existingClientPhones.add(phone);
      }

      return {
        createdBasePlaylists: createdBase,
        createdCustomPlaylists: createdCustom,
        createdClients
      };
    });

    return {
      success: true,
      replace,
      ...summary
    };
  }

  private async collectFullBackupPayload(
    reason: string,
    actor?: { userId?: string; email?: string }
  ): Promise<BackupPayload> {
    const [
      users,
      adminRegistrationRequests,
      passwordResetRequests,
      clients,
      devices,
      pairingSessions,
      playlistSources,
      playlistCaches,
      basePlaylists,
      basePlaylistCaches,
      customPlaylists,
      epgSources,
      epgSnapshots,
      ottProviders,
      ottChannels,
      ottPrograms,
      telemetryEvents,
      auditLogs
    ] = await Promise.all([
      this.prisma.user.findMany(),
      this.prisma.adminRegistrationRequest.findMany(),
      this.prisma.passwordResetRequest.findMany(),
      this.prisma.client.findMany(),
      this.prisma.device.findMany(),
      this.prisma.pairingSession.findMany(),
      this.prisma.playlistSource.findMany(),
      this.prisma.playlistCache.findMany(),
      this.prisma.basePlaylist.findMany(),
      this.prisma.basePlaylistCache.findMany(),
      this.prisma.customPlaylist.findMany(),
      this.prisma.epgSource.findMany(),
      this.prisma.epgSnapshot.findMany(),
      this.prisma.ottProvider.findMany(),
      this.prisma.ottChannel.findMany(),
      this.prisma.ottProgram.findMany(),
      this.prisma.telemetryEvent.findMany(),
      this.prisma.auditLog.findMany()
    ]);

    return {
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      actor: {
        userId: actor?.userId ?? null,
        email: actor?.email ?? null
      },
      data: {
        users: users as unknown as unknown[],
        adminRegistrationRequests: adminRegistrationRequests as unknown as unknown[],
        passwordResetRequests: passwordResetRequests as unknown as unknown[],
        clients: clients as unknown as unknown[],
        devices: devices as unknown as unknown[],
        pairingSessions: pairingSessions as unknown as unknown[],
        playlistSources: playlistSources as unknown as unknown[],
        playlistCaches: playlistCaches as unknown as unknown[],
        basePlaylists: basePlaylists as unknown as unknown[],
        basePlaylistCaches: basePlaylistCaches as unknown as unknown[],
        customPlaylists: customPlaylists as unknown as unknown[],
        epgSources: epgSources as unknown as unknown[],
        epgSnapshots: epgSnapshots as unknown as unknown[],
        ottProviders: ottProviders as unknown as unknown[],
        ottChannels: ottChannels as unknown as unknown[],
        ottPrograms: ottPrograms as unknown as unknown[],
        telemetryEvents: telemetryEvents as unknown as unknown[],
        auditLogs: auditLogs as unknown as unknown[]
      }
    };
  }

  private async restorePayload(payload: BackupPayload): Promise<void> {
    if (payload.version !== 1) {
      throw new BadRequestException('Unsupported backup format version');
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw new BadRequestException('Invalid backup payload');
    }

    const rows = payload.data as Record<string, Array<Record<string, unknown>>>;

    await this.prisma.$transaction(async (transaction) => {
      await transaction.ottProgram.deleteMany();
      await transaction.telemetryEvent.deleteMany();
      await transaction.pairingSession.deleteMany();
      await transaction.auditLog.deleteMany();
      await transaction.ottChannel.deleteMany();
      await transaction.device.deleteMany();
      await transaction.client.deleteMany();
      await transaction.basePlaylistCache.deleteMany();
      await transaction.playlistCache.deleteMany();
      await transaction.customPlaylist.deleteMany();
      await transaction.basePlaylist.deleteMany();
      await transaction.playlistSource.deleteMany();
      await transaction.epgSnapshot.deleteMany();
      await transaction.epgSource.deleteMany();
      await transaction.ottProvider.deleteMany();
      await transaction.passwordResetRequest.deleteMany();
      await transaction.adminRegistrationRequest.deleteMany();
      await transaction.user.deleteMany();

      await this.createManyIfAny(transaction.user, this.mapDates(rows.users, ['createdAt', 'updatedAt']));
      await this.createManyIfAny(
        transaction.adminRegistrationRequest,
        this.mapDates(rows.adminRegistrationRequests, ['expiresAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.passwordResetRequest,
        this.mapDates(rows.passwordResetRequests, ['expiresAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.client,
        this.mapDates(rows.clients, ['createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.device,
        this.mapDates(rows.devices, ['pairedAt', 'lastSeenAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.pairingSession,
        this.mapDates(rows.pairingSessions, ['expiresAt', 'confirmedAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.playlistSource,
        this.mapDates(rows.playlistSources, ['lastFetchedAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.playlistCache,
        this.mapDates(rows.playlistCaches, ['updatedAt', 'lastSuccessfulFetchAt'])
      );
      await this.createManyIfAny(
        transaction.basePlaylist,
        this.mapDates(rows.basePlaylists, ['lastFetchedAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.basePlaylistCache,
        this.mapDates(rows.basePlaylistCaches, ['updatedAt', 'lastSuccessfulFetchAt'])
      );
      await this.createManyIfAny(
        transaction.customPlaylist,
        this.mapDates(rows.customPlaylists, ['createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.epgSource,
        this.mapDates(rows.epgSources, ['lastIngestedAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.epgSnapshot,
        this.mapDates(rows.epgSnapshots, ['updatedAt', 'lastSuccessfulIngest'])
      );
      await this.createManyIfAny(
        transaction.ottProvider,
        this.mapDates(rows.ottProviders, ['lastSyncedAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.ottChannel,
        this.mapDates(rows.ottChannels, ['lastProgramsSyncAt', 'createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.ottProgram,
        this.mapDates(rows.ottPrograms, ['createdAt', 'updatedAt'])
      );
      await this.createManyIfAny(
        transaction.telemetryEvent,
        this.mapDates(rows.telemetryEvents, ['createdAt'])
      );
      await this.createManyIfAny(
        transaction.auditLog,
        this.mapDates(rows.auditLogs, ['createdAt'])
      );
    });
  }

  private async createManyIfAny(
    delegate: { createMany: unknown },
    rows: unknown[]
  ): Promise<void> {
    if (!rows || rows.length === 0) {
      return;
    }
    const createMany = delegate.createMany as (args: {
      data: unknown[];
      skipDuplicates: boolean;
    }) => Promise<unknown>;
    await createMany({
      data: rows,
      skipDuplicates: true
    });
  }

  private mapDates(
    rows: Array<Record<string, unknown>> | undefined,
    dateFields: string[]
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(rows)) {
      return [];
    }

    return rows.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      for (const field of dateFields) {
        const value = copy[field];
        if (value === null || value === undefined || value === '') {
          copy[field] = null;
          continue;
        }
        const date = new Date(String(value));
        if (Number.isNaN(date.getTime())) {
          copy[field] = null;
          continue;
        }
        copy[field] = date;
      }
      return copy;
    });
  }

  private normalizeImportConfig(rawConfig: Record<string, unknown>): ImportConfigShape {
    const version = Math.trunc(Number(rawConfig.version ?? 1));
    if (version !== 1) {
      throw new BadRequestException('Unsupported config version');
    }

    const activeCustomPlaylistName = this.optionalString(rawConfig.activeCustomPlaylistName);

    const basePlaylists = this.asObjectArray(rawConfig.basePlaylists).map((item) => ({
      name: this.requiredString(item.name, 'basePlaylists[].name'),
      url: this.requiredHttpUrl(item.url, 'basePlaylists[].url')
    }));
    if (basePlaylists.length > 300) {
      throw new BadRequestException('Too many base playlists');
    }
    const baseNames = new Set<string>();
    const baseUrls = new Set<string>();
    for (const base of basePlaylists) {
      const nameKey = base.name.toLowerCase();
      const urlKey = base.url.toLowerCase();
      if (baseNames.has(nameKey)) {
        throw new BadRequestException(`Duplicate base playlist name: ${base.name}`);
      }
      if (baseUrls.has(urlKey)) {
        throw new BadRequestException(`Duplicate base playlist URL: ${base.url}`);
      }
      baseNames.add(nameKey);
      baseUrls.add(urlKey);
    }

    const customPlaylists = this.asObjectArray(rawConfig.customPlaylists).map((item) => ({
      name: this.requiredString(item.name, 'customPlaylists[].name'),
      channelIds: this.asStringArray(item.channelIds),
      sourcePlaylistNames: this.asStringArray(item.sourcePlaylistNames),
      isActive: Boolean(item.isActive)
    }));
    if (customPlaylists.length > 500) {
      throw new BadRequestException('Too many custom playlists');
    }
    const customNames = new Set<string>();
    for (const custom of customPlaylists) {
      const key = custom.name.toLowerCase();
      if (customNames.has(key)) {
        throw new BadRequestException(`Duplicate custom playlist name: ${custom.name}`);
      }
      customNames.add(key);
      for (const sourceName of custom.sourcePlaylistNames) {
        if (!baseNames.has(sourceName.toLowerCase())) {
          throw new BadRequestException(
            `Unknown source playlist reference: ${sourceName} in ${custom.name}`
          );
        }
      }
    }

    if (activeCustomPlaylistName && !customNames.has(activeCustomPlaylistName.toLowerCase())) {
      throw new BadRequestException('activeCustomPlaylistName is not present in customPlaylists');
    }

    const clients = this.asObjectArray(rawConfig.clients).map((item) => ({
      firstName: this.requiredString(item.firstName, 'clients[].firstName'),
      lastName: this.requiredString(item.lastName, 'clients[].lastName'),
      phone: this.requiredString(item.phone, 'clients[].phone'),
      address: this.requiredString(item.address, 'clients[].address'),
      devicesAllowed: this.positiveInt(item.devicesAllowed, 'clients[].devicesAllowed'),
      sourcePlaylistNames: this.asStringArray(item.sourcePlaylistNames)
    }));
    if (clients.length > 10000) {
      throw new BadRequestException('Too many clients');
    }
    const phones = new Set<string>();
    for (const client of clients) {
      const phoneKey = client.phone.trim();
      if (phones.has(phoneKey)) {
        throw new BadRequestException(`Duplicate client phone: ${client.phone}`);
      }
      for (const sourceName of client.sourcePlaylistNames) {
        if (!baseNames.has(sourceName.toLowerCase())) {
          throw new BadRequestException(
            `Unknown source playlist reference in client ${client.phone}: ${sourceName}`
          );
        }
      }
      phones.add(phoneKey);
    }

    return {
      version,
      basePlaylists,
      customPlaylists,
      clients,
      activeCustomPlaylistName
    };
  }

  private asObjectArray(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object'
    );
  }

  private asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const unique = new Set<string>();
    const rows: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        continue;
      }
      const normalized = item.trim();
      if (!normalized || unique.has(normalized)) {
        continue;
      }
      unique.add(normalized);
      rows.push(normalized);
    }
    return rows;
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be string`);
    }
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`${field} is required`);
    }
    return normalized;
  }

  private optionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }
    if (normalized.length > 120) {
      throw new BadRequestException('String value is too long');
    }
    return normalized;
  }

  private requiredHttpUrl(value: unknown, field: string): string {
    const normalized = this.requiredString(value, field);
    return assertSafeHttpUrl(normalized).toString();
  }

  private positiveInt(value: unknown, field: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${field} must be number`);
    }
    const normalized = Math.trunc(parsed);
    if (normalized < 1) {
      throw new BadRequestException(`${field} must be >= 1`);
    }
    return normalized;
  }

  private normalizeBackupReason(rawReason: string): string {
    const reason = (rawReason || '').trim();
    if (!reason) {
      return 'manual';
    }
    return reason.slice(0, 120);
  }

  private normalizeBackupFileName(rawFileName: string): string {
    const fileName = rawFileName.trim();
    if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      throw new BadRequestException('Invalid backup filename');
    }
    if (!fileName.toLowerCase().endsWith('.json')) {
      throw new BadRequestException('Backup filename must end with .json');
    }
    return fileName;
  }

  private buildBackupFileName(reason: string): string {
    const safeReason = (reason || 'manual')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24);
    const stamp = new Date().toISOString().replace(/[:]/g, '-');
    return `backup-${stamp}-${safeReason || 'manual'}.json`;
  }

  private async ensureBackupDir(): Promise<void> {
    await fs.mkdir(this.backupDir, { recursive: true });
  }

  private async cleanupExpiredBackups(): Promise<void> {
    const entries = await fs.readdir(this.backupDir, { withFileTypes: true });
    const cutoffMs = Date.now() - this.backupRetentionDays * 24 * 60 * 60 * 1000;

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(async (entry) => {
          const fullPath = path.join(this.backupDir, entry.name);
          const stat = await fs.stat(fullPath);
          if (stat.mtime.getTime() < cutoffMs) {
            await fs.unlink(fullPath).catch(() => undefined);
          }
        })
    );
  }
}
