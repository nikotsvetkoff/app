import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { fetchTextWithRetry } from '../common/http.util';
import {
  parseChannelsTable,
  parseProgramsTable,
  parseProvidersTable,
  type ParsedChannelRow,
  type ParsedProgramRow,
  type ParsedProviderRow
} from './ott-catalog.parser';

const OTT_BASE_URL = 'https://epg.ott-play.com';
const OTT_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface SyncResult {
  synced: boolean;
  total: number;
}

@Injectable()
export class OttCatalogService {
  private readonly logger = new Logger(OttCatalogService.name);
  private readonly providersTtlMs: number;
  private readonly channelsTtlMs: number;
  private readonly programsTtlMs: number;
  private readonly defaultProgramSyncDelayMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {
    this.providersTtlMs = Number(this.configService.get('OTT_PROVIDERS_CACHE_TTL_SEC') ?? 3600) * 1000;
    this.channelsTtlMs = Number(this.configService.get('OTT_CHANNELS_CACHE_TTL_SEC') ?? 6 * 3600) * 1000;
    this.programsTtlMs = Number(this.configService.get('OTT_PROGRAMS_CACHE_TTL_SEC') ?? 2 * 3600) * 1000;
    this.defaultProgramSyncDelayMs = Number(this.configService.get('OTT_PROGRAMS_SYNC_DELAY_MS') ?? 250);
  }

  async listProviders(userId: string) {
    await this.tryAutoSyncProviders(userId);

    const rows = await this.prisma.ottProvider.findMany({
      where: { userId },
      orderBy: [{ key: 'asc' }],
      include: {
        _count: {
          select: {
            channels: true
          }
        }
      }
    });

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      sourcePath: row.sourcePath,
      channelsPath: row.channelsPath,
      updatedLabel: row.updatedLabel,
      sizeLabel: row.sizeLabel,
      channelsCountRemote: row.channelsCount,
      channelsCountStored: row._count.channels,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }));
  }

  async listChannels(userId: string, providerId: string, search = '', limit = 200) {
    const provider = await this.requireProvider(userId, providerId);
    await this.tryAutoSyncChannels(provider.id, userId);

    const normalizedSearch = search.trim();
    const rows = await this.prisma.ottChannel.findMany({
      where: {
        providerId: provider.id,
        ...(normalizedSearch
          ? {
              OR: [
                { displayName: { contains: normalizedSearch, mode: 'insensitive' } },
                { tvgId: { contains: normalizedSearch, mode: 'insensitive' } }
              ]
            }
          : {})
      },
      orderBy: [{ displayName: 'asc' }],
      take: limit
    });

    return {
      provider: {
        id: provider.id,
        key: provider.key,
        sourcePath: provider.sourcePath
      },
      channels: rows.map((row) => ({
        id: row.id,
        externalKey: row.externalKey,
        displayName: row.displayName,
        tvgId: row.tvgId,
        logoUrl: row.logoUrl,
        epgPath: row.epgPath,
        epgUrl: row.epgUrl,
        programCount: row.programCount,
        lastProgramsSyncAt: row.lastProgramsSyncAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      }))
    };
  }

  async listPrograms(userId: string, channelId: string, limit = 250) {
    const channel = await this.requireChannel(userId, channelId);
    await this.tryAutoSyncPrograms(channel.id, userId);

    const rows = await this.prisma.ottProgram.findMany({
      where: { channelId: channel.id },
      orderBy: [{ sequence: 'asc' }],
      take: limit
    });

    return {
      channel: {
        id: channel.id,
        displayName: channel.displayName,
        tvgId: channel.tvgId,
        epgPath: channel.epgPath,
        epgUrl: channel.epgUrl,
        programCount: channel.programCount,
        lastProgramsSyncAt: channel.lastProgramsSyncAt?.toISOString() ?? null
      },
      programs: rows.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        dateLabel: row.dateLabel,
        timeLabel: row.timeLabel,
        title: row.title,
        description: row.description
      }))
    };
  }

  async syncProviders(userId: string, force = false): Promise<SyncResult> {
    const latest = await this.prisma.ottProvider.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true }
    });

    if (!force && latest && Date.now() - latest.updatedAt.getTime() < this.providersTtlMs) {
      const total = await this.prisma.ottProvider.count({ where: { userId } });
      return {
        synced: false,
        total
      };
    }

    const html = await this.fetchOttHtml('/');
    const providers = parseProvidersTable(html);

    if (providers.length === 0) {
      throw new BadRequestException('Не удалось разобрать список провайдеров из ott-play');
    }

    const keys = providers.map((provider) => provider.key);
    const now = new Date();

    await this.prisma.$transaction([
      ...providers.map((provider) =>
        this.prisma.ottProvider.upsert({
          where: {
            userId_key: {
              userId,
              key: provider.key
            }
          },
          create: this.mapProviderCreate(userId, provider, now),
          update: this.mapProviderUpdate(provider, now)
        })
      ),
      this.prisma.ottProvider.deleteMany({
        where: {
          userId,
          key: {
            notIn: keys
          }
        }
      })
    ]);

    return {
      synced: true,
      total: providers.length
    };
  }

  async syncProviderChannels(userId: string, providerId: string, force = false): Promise<SyncResult> {
    const provider = await this.requireProvider(userId, providerId);
    const latestChannel = await this.prisma.ottChannel.findFirst({
      where: {
        providerId: provider.id
      },
      orderBy: {
        updatedAt: 'desc'
      },
      select: {
        updatedAt: true
      }
    });

    if (!force && latestChannel && Date.now() - latestChannel.updatedAt.getTime() < this.channelsTtlMs) {
      const total = await this.prisma.ottChannel.count({
        where: { providerId: provider.id }
      });
      return {
        synced: false,
        total
      };
    }

    const html = await this.fetchOttHtml(provider.channelsPath);
    const parsed = parseChannelsTable(html);
    if (parsed.channels.length === 0) {
      throw new BadRequestException(`Не удалось получить список каналов провайдера ${provider.key}`);
    }

    const now = new Date();
    const channelRows = this.deduplicateChannelRows(
      parsed.channels.map((channel) => this.mapChannelCreate(userId, provider.id, channel))
    );
    await this.prisma.$transaction(async (transaction) => {
      await transaction.ottChannel.deleteMany({
        where: {
          providerId: provider.id
        }
      });

      if (channelRows.length > 0) {
        await transaction.ottChannel.createMany({
          data: channelRows
        });
      }

      await transaction.ottProvider.update({
        where: { id: provider.id },
        data: {
          channelsCount: parsed.meta.channelsCount ?? parsed.channels.length,
          updatedLabel: parsed.meta.updatedLabel ?? provider.updatedLabel,
          lastSyncedAt: now
        }
      });
    });

    return {
      synced: true,
      total: channelRows.length
    };
  }

  async syncChannelPrograms(userId: string, channelId: string, force = false): Promise<SyncResult> {
    const channel = await this.requireChannel(userId, channelId);
    if (!channel.epgPath) {
      throw new BadRequestException('Для этого канала отсутствует ссылка на EPG');
    }

    if (
      !force &&
      channel.lastProgramsSyncAt &&
      Date.now() - channel.lastProgramsSyncAt.getTime() < this.programsTtlMs &&
      channel.programCount > 0
    ) {
      return {
        synced: false,
        total: channel.programCount
      };
    }

    const html = await this.fetchOttHtml(channel.epgPath);
    const parsed = parseProgramsTable(html);

    const now = new Date();
    const records = parsed.programs.map((program) => this.mapProgramCreate(userId, channel.providerId, channel.id, program));

    await this.prisma.$transaction(async (transaction) => {
      await transaction.ottProgram.deleteMany({
        where: {
          channelId: channel.id
        }
      });

      if (records.length > 0) {
        await transaction.ottProgram.createMany({
          data: records
        });
      }

      await transaction.ottChannel.update({
        where: {
          id: channel.id
        },
        data: {
          programCount: parsed.meta.programCount ?? parsed.programs.length,
          lastProgramsSyncAt: now
        }
      });
    });

    return {
      synced: true,
      total: parsed.programs.length
    };
  }

  async syncProviderPrograms(
    userId: string,
    providerId: string,
    options: {
      force?: boolean;
      limitChannels?: number;
      delayMs?: number;
      skipChannelsSync?: boolean;
    } = {}
  ) {
    const force = options.force ?? false;
    const limitChannels = options.limitChannels ?? 30;
    const delayMs = options.delayMs ?? this.defaultProgramSyncDelayMs;
    const skipChannelsSync = options.skipChannelsSync ?? false;

    if (!skipChannelsSync) {
      await this.syncProviderChannels(userId, providerId, force);
    }

    const channels = await this.prisma.ottChannel.findMany({
      where: {
        providerId,
        epgPath: {
          not: null
        }
      },
      orderBy: {
        displayName: 'asc'
      },
      take: limitChannels
    });

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index];
      try {
        const result = await this.syncChannelPrograms(userId, channel.id, force);
        if (result.synced) {
          synced += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        const message =
          error instanceof Error
            ? error.message
            : `Ошибка загрузки программ для канала ${channel.displayName}`;
        errors.push(`${channel.displayName}: ${message}`);
      }

      if (index < channels.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return {
      providerId,
      processedChannels: channels.length,
      syncedChannels: synced,
      skippedChannels: skipped,
      failedChannels: failed,
      delayMs,
      errors: errors.slice(0, 20)
    };
  }

  async syncFullCatalog(
    userId: string,
    options: {
      force?: boolean;
      providerLimit?: number;
      channelsPerProvider?: number;
      delayMs?: number;
    } = {}
  ) {
    const force = options.force ?? false;
    const providerLimit = options.providerLimit ?? 8;
    const channelsPerProvider = options.channelsPerProvider ?? 20;
    const delayMs = options.delayMs ?? this.defaultProgramSyncDelayMs;

    await this.syncProviders(userId, force);

    const providers = await this.prisma.ottProvider.findMany({
      where: { userId },
      orderBy: {
        key: 'asc'
      },
      take: providerLimit
    });

    const results: Array<{
      providerId: string;
      key: string;
      channelsResult?: SyncResult;
      programsResult?: {
        processedChannels: number;
        syncedChannels: number;
        skippedChannels: number;
        failedChannels: number;
      };
      error?: string;
    }> = [];

    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      try {
        const channelsResult = await this.syncProviderChannels(userId, provider.id, force);
        const programsResult = await this.syncProviderPrograms(userId, provider.id, {
          force,
          limitChannels: channelsPerProvider,
          delayMs,
          skipChannelsSync: true
        });

        results.push({
          providerId: provider.id,
          key: provider.key,
          channelsResult,
          programsResult: {
            processedChannels: programsResult.processedChannels,
            syncedChannels: programsResult.syncedChannels,
            skippedChannels: programsResult.skippedChannels,
            failedChannels: programsResult.failedChannels
          }
        });
      } catch (error) {
        results.push({
          providerId: provider.id,
          key: provider.key,
          error: error instanceof Error ? error.message : 'Неизвестная ошибка'
        });
      }

      if (index < providers.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    const successCount = results.filter((item) => !item.error).length;
    return {
      providersProcessed: providers.length,
      providersSucceeded: successCount,
      providersFailed: providers.length - successCount,
      providerLimit,
      channelsPerProvider,
      delayMs,
      results
    };
  }

  async getStats(userId: string) {
    const [providers, channels, programs] = await Promise.all([
      this.prisma.ottProvider.count({ where: { userId } }),
      this.prisma.ottChannel.count({ where: { userId } }),
      this.prisma.ottProgram.count({ where: { userId } })
    ]);

    return {
      providers,
      channels,
      programs
    };
  }

  private async requireProvider(userId: string, providerId: string) {
    const provider = await this.prisma.ottProvider.findFirst({
      where: {
        id: providerId,
        userId
      }
    });
    if (!provider) {
      throw new NotFoundException('Провайдер не найден');
    }
    return provider;
  }

  private async requireChannel(userId: string, channelId: string) {
    const channel = await this.prisma.ottChannel.findFirst({
      where: {
        id: channelId,
        userId
      }
    });
    if (!channel) {
      throw new NotFoundException('Канал не найден');
    }
    return channel;
  }

  private async tryAutoSyncProviders(userId: string): Promise<void> {
    const existingCount = await this.prisma.ottProvider.count({ where: { userId } });
    try {
      await this.syncProviders(userId, false);
    } catch (error) {
      if (existingCount > 0) {
        this.logger.warn(`Providers auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
  }

  private async tryAutoSyncChannels(providerId: string, userId: string): Promise<void> {
    const existingCount = await this.prisma.ottChannel.count({
      where: {
        providerId,
        userId
      }
    });
    try {
      await this.syncProviderChannels(userId, providerId, false);
    } catch (error) {
      if (existingCount > 0) {
        this.logger.warn(`Channels auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
  }

  private async tryAutoSyncPrograms(channelId: string, userId: string): Promise<void> {
    const existingCount = await this.prisma.ottProgram.count({
      where: {
        channelId,
        userId
      }
    });
    try {
      await this.syncChannelPrograms(userId, channelId, false);
    } catch (error) {
      if (existingCount > 0) {
        this.logger.warn(`Programs auto-sync failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
  }

  private mapProviderCreate(userId: string, provider: ParsedProviderRow, now: Date) {
    return {
      userId,
      key: provider.key,
      sourcePath: provider.sourcePath,
      channelsPath: provider.channelsPath,
      updatedLabel: provider.updatedLabel || null,
      sizeLabel: provider.sizeLabel || null,
      channelsCount: provider.channelsCount,
      lastSyncedAt: now
    };
  }

  private mapProviderUpdate(provider: ParsedProviderRow, now: Date) {
    return {
      sourcePath: provider.sourcePath,
      channelsPath: provider.channelsPath,
      updatedLabel: provider.updatedLabel || null,
      sizeLabel: provider.sizeLabel || null,
      channelsCount: provider.channelsCount,
      lastSyncedAt: now
    };
  }

  private mapChannelCreate(userId: string, providerId: string, channel: ParsedChannelRow) {
    return {
      userId,
      providerId,
      externalKey: channel.externalKey,
      displayName: channel.displayName,
      tvgId: channel.tvgId,
      logoUrl: this.normalizeToAbsoluteUrl(channel.logoUrl),
      epgPath: channel.epgPath,
      epgUrl: this.normalizeToAbsoluteUrl(channel.epgPath)
    };
  }

  private mapProgramCreate(userId: string, providerId: string, channelId: string, program: ParsedProgramRow) {
    return {
      userId,
      providerId,
      channelId,
      sequence: program.sequence,
      dateLabel: program.dateLabel,
      timeLabel: program.timeLabel,
      title: program.title,
      description: program.description
    };
  }

  private deduplicateChannelRows<
    TRow extends {
      externalKey: string;
      tvgId?: string | null;
      epgPath?: string | null;
      logoUrl?: string | null;
    }
  >(rows: TRow[]): TRow[] {
    const uniqueRows = new Map<string, TRow>();

    for (const row of rows) {
      const existing = uniqueRows.get(row.externalKey);
      if (!existing) {
        uniqueRows.set(row.externalKey, row);
        continue;
      }

      if (this.scoreChannelRow(row) > this.scoreChannelRow(existing)) {
        uniqueRows.set(row.externalKey, row);
      }
    }

    return [...uniqueRows.values()];
  }

  private scoreChannelRow(row: { tvgId?: string | null; epgPath?: string | null; logoUrl?: string | null }): number {
    let score = 0;
    if (row.tvgId) {
      score += 4;
    }
    if (row.epgPath) {
      score += 2;
    }
    if (row.logoUrl) {
      score += 1;
    }
    return score;
  }

  private normalizeToAbsoluteUrl(rawPath: string | null): string | null {
    if (!rawPath) {
      return null;
    }

    try {
      return new URL(rawPath, OTT_BASE_URL).toString();
    } catch {
      return null;
    }
  }

  private async fetchOttHtml(pathOrUrl: string): Promise<string> {
    const targetUrl = this.normalizeToAbsoluteUrl(pathOrUrl);
    if (!targetUrl) {
      throw new BadRequestException('Некорректная ссылка для загрузки OTT каталога');
    }

    try {
      return await fetchTextWithRetry(targetUrl, {
        timeoutMs: 20000,
        retries: 2,
        backoffMs: 1000,
        headers: OTT_BROWSER_HEADERS
      });
    } catch (error) {
      this.logger.warn(`OTT fetch failed for ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('Не удалось загрузить данные с epg.ott-play.com');
    }
  }
}
