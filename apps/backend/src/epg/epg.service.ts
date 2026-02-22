import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, EpgProgram } from '@iptv/core';
import { filterProgramsByDay, getNowNext } from '@iptv/core';
import { PrismaService } from '../prisma/prisma.service';
import { assertSafeHttpUrl } from '../common/url-safety.util';
import { OttCatalogService } from '../ott-catalog/ott-catalog.service';

const OTT_BASE_URL = 'https://epg.ott-play.com';
const OTT_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const OTT_TIME_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;

const toInt = (raw: string): number => Number.parseInt(raw, 10);

const parseOttRangeToIso = (
  dateLabel: string,
  timeLabel: string
): { start: string; end: string } | null => {
  const normalizedDate = dateLabel.trim();
  const normalizedTime = timeLabel.trim();

  const dateMatch = normalizedDate.match(OTT_DATE_RE);
  const timeMatch = normalizedTime.match(OTT_TIME_RE);
  if (!dateMatch || !timeMatch) {
    return null;
  }

  const day = toInt(dateMatch[1]);
  const month = toInt(dateMatch[2]);
  const year = toInt(dateMatch[3]);
  const startHour = toInt(timeMatch[1]);
  const startMinute = toInt(timeMatch[2]);
  const endHour = toInt(timeMatch[3]);
  const endMinute = toInt(timeMatch[4]);

  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return null;
  }

  const start = new Date(year, month - 1, day, startHour, startMinute, 0, 0);
  const end = new Date(year, month - 1, day, endHour, endMinute, 0, 0);

  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }

  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
};

@Injectable()
export class EpgService {
  private readonly ottDefaultProviderKey: string;
  private readonly ottProviderCandidateKeys: string[];
  private readonly ottProgramsTtlMs: number;
  private readonly ottAutoSyncMaxChannelsPerRequest: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OttCatalogService) private readonly ottCatalogService: OttCatalogService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {
    this.ottDefaultProviderKey = String(
      this.configService.get('OTT_DEFAULT_PROVIDER_KEY') ?? 'cbilling'
    )
      .trim()
      .toLowerCase();
    this.ottProviderCandidateKeys = [
      ...new Set([
        this.ottDefaultProviderKey,
        ...String(this.configService.get('OTT_FALLBACK_PROVIDER_KEYS') ?? 'edem')
          .split(',')
          .map((key) => key.trim().toLowerCase())
          .filter(Boolean)
      ])
    ];
    this.ottProgramsTtlMs = Number(this.configService.get('OTT_PROGRAMS_CACHE_TTL_SEC') ?? 7200) * 1000;
    this.ottAutoSyncMaxChannelsPerRequest = Number(
      this.configService.get('OTT_AUTO_SYNC_MAX_CHANNELS_PER_REQUEST') ?? 12
    );
  }

  // Endpoint kept for compatibility with existing admin UI. EPG source is static from ott-play now.
  async setEpgUrl(_userId: string, rawUrl: string): Promise<{ success: true }> {
    assertSafeHttpUrl(rawUrl);
    return { success: true };
  }

  async getEpgStatus(userId: string) {
    const provider = await this.getOrCreateDefaultProvider(userId);

    const [channelsCount, programsCount] = provider
      ? await Promise.all([
          this.prisma.ottChannel.count({
            where: {
              userId,
              providerId: provider.id
            }
          }),
          this.prisma.ottProgram.count({
            where: {
              userId,
              providerId: provider.id
            }
          })
        ])
      : [0, 0];

    return {
      mode: 'auto-ott-play-static',
      sourceUrl: OTT_BASE_URL,
      providerKey: this.ottDefaultProviderKey,
      providerId: provider?.id ?? null,
      providerLastSyncedAt: provider?.lastSyncedAt ?? null,
      channelsCount,
      programsCount
    };
  }

  async getNowNextForDevice(deviceId: string, channels: Channel[]) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device?.userId) {
      throw new NotFoundException('Устройство не привязано');
    }

    const tvgIds = this.extractTvgIds(channels);
    const programs = await this.getProgramsFromOttCatalog(device.userId, tvgIds);

    const mapped = getNowNext(programs.filter((program) => tvgIds.has(program.channelTvgId)));

    return channels.map((channel) => ({
      channelId: channel.id,
      channelTvgId: channel.tvgId,
      now: channel.tvgId ? mapped.get(channel.tvgId)?.now : undefined,
      next: channel.tvgId ? mapped.get(channel.tvgId)?.next : undefined
    }));
  }

  async getDayGridForDevice(deviceId: string, channels: Channel[], day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new BadRequestException('Дата должна быть в формате YYYY-MM-DD');
    }

    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device?.userId) {
      throw new NotFoundException('Устройство не привязано');
    }

    const tvgIds = this.extractTvgIds(channels);
    const programs = await this.getProgramsFromOttCatalog(device.userId, tvgIds);
    const dayPrograms = filterProgramsByDay(programs, day);

    const response = new Map<string, EpgProgram[]>();

    for (const program of dayPrograms) {
      if (!tvgIds.has(program.channelTvgId)) {
        continue;
      }
      const existing = response.get(program.channelTvgId) ?? [];
      existing.push(program);
      response.set(program.channelTvgId, existing);
    }

    return [...response.entries()].map(([channelTvgId, programsList]) => ({
      channelTvgId,
      programs: programsList
    }));
  }

  private extractTvgIds(channels: Channel[]): Set<string> {
    return new Set(channels.map((channel) => channel.tvgId).filter(Boolean) as string[]);
  }

  private async getOrCreateDefaultProvider(userId: string) {
    let provider = await this.prisma.ottProvider.findFirst({
      where: {
        userId,
        key: this.ottDefaultProviderKey
      },
      select: {
        id: true,
        key: true,
        lastSyncedAt: true
      }
    });

    if (!provider) {
      try {
        await this.ottCatalogService.syncProviders(userId, false);
      } catch {
        return null;
      }

      provider = await this.prisma.ottProvider.findFirst({
        where: {
          userId,
          key: this.ottDefaultProviderKey
        },
        select: {
          id: true,
          key: true,
          lastSyncedAt: true
        }
      });
    }

    return provider;
  }

  private async getProgramsFromOttCatalog(userId: string, tvgIds: Set<string>): Promise<EpgProgram[]> {
    const tvgIdsList = [...tvgIds];
    if (tvgIdsList.length === 0) {
      return [];
    }

    const channels = await this.getBestProviderChannels(userId, tvgIdsList);

    if (channels.length === 0) {
      return [];
    }

    let syncCount = 0;
    for (const channel of channels) {
      const isStale =
        !channel.lastProgramsSyncAt ||
        Date.now() - channel.lastProgramsSyncAt.getTime() > this.ottProgramsTtlMs ||
        channel.programCount === 0;

      if (!isStale) {
        continue;
      }
      if (syncCount >= this.ottAutoSyncMaxChannelsPerRequest) {
        break;
      }

      try {
        await this.ottCatalogService.syncChannelPrograms(userId, channel.id, false);
      } catch {
        // If one channel fails, continue with the rest.
      }

      syncCount += 1;
    }

    const programsRows = await this.prisma.ottProgram.findMany({
      where: {
        channelId: {
          in: channels.map((channel) => channel.id)
        }
      },
      orderBy: [{ channelId: 'asc' }, { sequence: 'asc' }],
      select: {
        dateLabel: true,
        timeLabel: true,
        title: true,
        description: true,
        channel: {
          select: {
            tvgId: true
          }
        }
      }
    });

    const programs: EpgProgram[] = [];
    for (const row of programsRows) {
      if (!row.channel.tvgId) {
        continue;
      }

      const parsedRange = parseOttRangeToIso(row.dateLabel, row.timeLabel);
      if (!parsedRange) {
        continue;
      }

      programs.push({
        channelTvgId: row.channel.tvgId,
        title: row.title,
        start: parsedRange.start,
        end: parsedRange.end,
        description: row.description ?? undefined
      });
    }

    return programs;
  }

  private async getBestProviderChannels(
    userId: string,
    tvgIdsList: string[]
  ): Promise<Array<{ id: string; tvgId: string | null; programCount: number; lastProgramsSyncAt: Date | null }>> {
    const providers = await this.getCandidateProviders(userId);
    if (providers.length === 0) {
      return [];
    }

    let bestChannels: Array<{
      id: string;
      tvgId: string | null;
      programCount: number;
      lastProgramsSyncAt: Date | null;
    }> = [];

    for (const provider of providers) {
      try {
        await this.ottCatalogService.syncProviderChannels(userId, provider.id, false);
      } catch {
        // Continue with existing cached DB data for this provider.
      }

      const channels = await this.prisma.ottChannel.findMany({
        where: {
          userId,
          providerId: provider.id,
          epgPath: {
            not: null
          },
          tvgId: {
            in: tvgIdsList
          }
        },
        select: {
          id: true,
          tvgId: true,
          programCount: true,
          lastProgramsSyncAt: true
        }
      });

      if (channels.length > bestChannels.length) {
        bestChannels = channels;
      }

      if (bestChannels.length >= tvgIdsList.length) {
        break;
      }
    }

    return bestChannels;
  }

  private async getCandidateProviders(
    userId: string
  ): Promise<Array<{ id: string; key: string; lastSyncedAt: Date | null }>> {
    let providers = await this.prisma.ottProvider.findMany({
      where: {
        userId,
        key: {
          in: this.ottProviderCandidateKeys
        }
      },
      select: {
        id: true,
        key: true,
        lastSyncedAt: true
      }
    });

    if (providers.length === 0) {
      try {
        await this.ottCatalogService.syncProviders(userId, false);
      } catch {
        return [];
      }

      providers = await this.prisma.ottProvider.findMany({
        where: {
          userId,
          key: {
            in: this.ottProviderCandidateKeys
          }
        },
        select: {
          id: true,
          key: true,
          lastSyncedAt: true
        }
      });
    }

    const providersByKey = new Map(
      providers.map((provider) => [provider.key.trim().toLowerCase(), provider] as const)
    );

    return this.ottProviderCandidateKeys
      .map((key) => providersByKey.get(key))
      .filter(
        (provider): provider is { id: string; key: string; lastSyncedAt: Date | null } =>
          Boolean(provider)
      );
  }
}
