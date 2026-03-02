import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, EpgProgram } from '@iptv/core';
import type { Prisma } from '@prisma/client';
import { filterProgramsByDay, getNowNext } from '@iptv/core';
import { PrismaService } from '../prisma/prisma.service';
import { fetchWithRetry } from '../common/http.util';
import { assertSafeHttpUrl } from '../common/url-safety.util';
import { OttCatalogService } from '../ott-catalog/ott-catalog.service';
import { parseXmlTvNowNextSnapshot, type XmlTvNowNextSnapshot } from './xmltv.parser';

const OTT_BASE_URL = 'https://epg.ott-play.com';
const DEFAULT_XMLTV_SOURCE_URL =
  'https://epg.ott-play.com/php/show_prow.php?f=epgshare/epg_ripper_ALL_SOURCES1.xml.gz';
const OTT_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const OTT_TIME_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
const XMLTV_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};

const toInt = (raw: string): number => Number.parseInt(raw, 10);
const normalizeTvgId = (raw: string): string => raw.trim().toLowerCase();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface NowNextEntry {
  now?: EpgProgram;
  next?: EpgProgram;
}

interface XmlTvSourceRecord {
  url: string;
  lastIngestedAt: Date | null;
  lastError: string | null;
  updatedAt: Date | null;
}

interface OttChannelCandidate {
  id: string;
  tvgId: string | null;
  programCount: number;
  lastProgramsSyncAt: Date | null;
  logoUrl: string | null;
}

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
  private readonly logger = new Logger(EpgService.name);
  private readonly ottDefaultProviderKey: string;
  private readonly ottProviderCandidateKeys: string[];
  private readonly ottAutoScanAllProviders: boolean;
  private readonly ottAutoScanProviderLimit: number;
  private readonly ottProgramsTtlMs: number;
  private readonly ottAutoSyncMaxChannelsPerRequest: number;
  private readonly ottProgramsWarmupInFlight = new Set<string>();
  private readonly ottProviderChannelsWarmupInFlight = new Set<string>();
  private readonly xmlTvDefaultSourceUrl: string;
  private readonly xmlTvSnapshotTtlMs: number;
  private readonly xmlTvFetchTimeoutMs: number;
  private readonly xmlTvFetchRetries: number;
  private readonly xmlTvRetryAfterFailureMs: number;
  private readonly xmlTvRefreshInFlight = new Map<string, Promise<XmlTvNowNextSnapshot | null>>();

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
    this.ottAutoScanAllProviders =
      String(this.configService.get('OTT_AUTO_SCAN_ALL_PROVIDERS') ?? 'true').toLowerCase() !==
      'false';
    this.ottAutoScanProviderLimit = Math.max(
      Number(this.configService.get('OTT_AUTO_SCAN_PROVIDER_LIMIT') ?? 8),
      1
    );
    this.ottProgramsTtlMs = Number(this.configService.get('OTT_PROGRAMS_CACHE_TTL_SEC') ?? 7200) * 1000;
    this.ottAutoSyncMaxChannelsPerRequest = Number(
      this.configService.get('OTT_AUTO_SYNC_MAX_CHANNELS_PER_REQUEST') ?? 12
    );

    const configuredXmlTvUrl = String(
      this.configService.get('EPG_XMLTV_SOURCE_URL') ??
        this.configService.get('EPG_XMLTV_URL') ??
        DEFAULT_XMLTV_SOURCE_URL
    )
      .trim()
      .replace(/\s+/g, '');

    this.xmlTvDefaultSourceUrl = configuredXmlTvUrl || DEFAULT_XMLTV_SOURCE_URL;
    this.xmlTvSnapshotTtlMs = Number(this.configService.get('EPG_XMLTV_SNAPSHOT_TTL_SEC') ?? 1800) * 1000;
    this.xmlTvFetchTimeoutMs = Number(this.configService.get('EPG_XMLTV_FETCH_TIMEOUT_MS') ?? 240000);
    this.xmlTvFetchRetries = Number(this.configService.get('EPG_XMLTV_FETCH_RETRIES') ?? 1);
    this.xmlTvRetryAfterFailureMs =
      Number(this.configService.get('EPG_XMLTV_RETRY_AFTER_FAILURE_SEC') ?? 300) * 1000;
  }

  async setEpgUrl(userId: string, rawUrl: string): Promise<{ success: true }> {
    const safeUrl = assertSafeHttpUrl(rawUrl).toString();

    await this.prisma.epgSource.upsert({
      where: {
        userId
      },
      create: {
        userId,
        url: safeUrl,
        lastError: null
      },
      update: {
        url: safeUrl,
        lastError: null
      }
    });

    return { success: true };
  }

  async getEpgStatus(userId: string) {
    const [provider, source, snapshot] = await Promise.all([
      this.getOrCreateDefaultProvider(userId),
      this.getEffectiveXmlTvSource(userId),
      this.prisma.epgSnapshot.findUnique({
        where: {
          userId
        },
        select: {
          programsJson: true,
          updatedAt: true,
          lastSuccessfulIngest: true
        }
      })
    ]);

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

    const snapshotParsed = this.parseStoredXmlTvSnapshot(snapshot?.programsJson);
    const snapshotChannels = Object.keys(snapshotParsed?.nowNextByTvgId ?? {}).length;
    const xmlSnapshotAllowed = this.isXmlSnapshotIngestAllowed(source.url);

    return {
      mode: 'auto-ott+xmltv-snapshot',
      sourceUrl: source.url,
      sourceLastIngestedAt: source.lastIngestedAt?.toISOString() ?? null,
      sourceLastError: xmlSnapshotAllowed ? source.lastError : null,
      sourceUpdatedAt: source.updatedAt?.toISOString() ?? null,
      snapshotUpdatedAt: snapshot?.updatedAt?.toISOString() ?? null,
      snapshotGeneratedAt: snapshotParsed?.generatedAt ?? null,
      snapshotChannels,
      snapshotLastSuccessfulIngest: snapshot?.lastSuccessfulIngest?.toISOString() ?? null,
      ottSourceUrl: OTT_BASE_URL,
      providerKey: this.ottDefaultProviderKey,
      autoScanAllProviders: this.ottAutoScanAllProviders,
      autoScanProviderLimit: this.ottAutoScanProviderLimit,
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

    const [ottData, xmlTvSnapshot] = await Promise.all([
      this.getProgramsAndLogosFromOttCatalog(device.userId, tvgIds),
      this.getXmlTvSnapshot(device.userId)
    ]);
    const { programs, logosByTvgId: ottLogosByTvgId } = ottData;

    const requestedTvgIdsNormalized = new Set([...tvgIds].map((value) => normalizeTvgId(value)));
    const ottMapped = getNowNext(
      programs.filter((program) => requestedTvgIdsNormalized.has(normalizeTvgId(program.channelTvgId)))
    );
    const ottMappedNormalized = new Map<string, NowNextEntry>();
    for (const [channelTvgId, entry] of ottMapped.entries()) {
      const normalized = normalizeTvgId(channelTvgId);
      if (!normalized) {
        continue;
      }
      ottMappedNormalized.set(normalized, {
        now: entry.now,
        next: entry.next
      });
    }

    return channels.map((channel) => {
      const normalizedTvgId = channel.tvgId ? normalizeTvgId(channel.tvgId) : '';
      const xmlEntry = normalizedTvgId ? xmlTvSnapshot?.nowNextByTvgId[normalizedTvgId] : undefined;
      const ottEntry = normalizedTvgId ? ottMappedNormalized.get(normalizedTvgId) : undefined;

      return {
        channelId: channel.id,
        channelTvgId: channel.tvgId,
        channelLogo: normalizedTvgId
          ? (xmlTvSnapshot?.logosByTvgId[normalizedTvgId] ?? ottLogosByTvgId[normalizedTvgId])
          : undefined,
        now: xmlEntry?.now ?? ottEntry?.now,
        next: xmlEntry?.next ?? ottEntry?.next
      };
    });
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
    const { programs } = await this.getProgramsAndLogosFromOttCatalog(device.userId, tvgIds);
    const dayPrograms = filterProgramsByDay(programs, day);
    const requestedTvgIdsNormalized = new Set([...tvgIds].map((value) => normalizeTvgId(value)));

    const response = new Map<string, EpgProgram[]>();

    for (const program of dayPrograms) {
      if (!requestedTvgIdsNormalized.has(normalizeTvgId(program.channelTvgId))) {
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

  private async getXmlTvSnapshot(userId: string): Promise<XmlTvNowNextSnapshot | null> {
    const source = await this.getEffectiveXmlTvSource(userId);
    const snapshotRow = await this.prisma.epgSnapshot.findUnique({
      where: {
        userId
      },
      select: {
        programsJson: true,
        updatedAt: true
      }
    });

    const cachedSnapshot = this.parseStoredXmlTvSnapshot(snapshotRow?.programsJson);
    const isFresh =
      Boolean(snapshotRow && cachedSnapshot) &&
      Date.now() - (snapshotRow?.updatedAt.getTime() ?? 0) <= this.xmlTvSnapshotTtlMs;

    if (isFresh) {
      return cachedSnapshot;
    }

    if (!this.isXmlSnapshotIngestAllowed(source.url)) {
      return cachedSnapshot;
    }

    const hasRecentFailure =
      Boolean(source.lastError && source.updatedAt) &&
      Date.now() - (source.updatedAt?.getTime() ?? 0) <= this.xmlTvRetryAfterFailureMs;
    if (hasRecentFailure) {
      return cachedSnapshot;
    }

    const refreshedSnapshot = await this.refreshXmlTvSnapshotLocked(userId, source.url);
    return refreshedSnapshot ?? cachedSnapshot;
  }

  private isXmlSnapshotIngestAllowed(sourceUrl: string): boolean {
    const normalized = sourceUrl.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    // ott-play show_prow endpoint renders HTML table, not XMLTV snapshot.
    if (normalized.includes('/php/show_prow.php')) {
      return false;
    }

    return true;
  }

  private async refreshXmlTvSnapshotLocked(
    userId: string,
    sourceUrl: string
  ): Promise<XmlTvNowNextSnapshot | null> {
    const inFlight = this.xmlTvRefreshInFlight.get(userId);
    if (inFlight) {
      return inFlight;
    }

    const task = this.refreshXmlTvSnapshot(userId, sourceUrl).finally(() => {
      this.xmlTvRefreshInFlight.delete(userId);
    });

    this.xmlTvRefreshInFlight.set(userId, task);
    return task;
  }

  private async refreshXmlTvSnapshot(
    userId: string,
    sourceUrl: string
  ): Promise<XmlTvNowNextSnapshot | null> {
    try {
      const response = await fetchWithRetry(sourceUrl, {
        timeoutMs: this.xmlTvFetchTimeoutMs,
        retries: this.xmlTvFetchRetries,
        backoffMs: 1500,
        headers: XMLTV_HEADERS
      });
      const parsed = await parseXmlTvNowNextSnapshot(response, {
        assumeGzip: sourceUrl.toLowerCase().includes('.gz')
      });

      const now = new Date();

      await this.prisma.$transaction([
        this.prisma.epgSource.upsert({
          where: {
            userId
          },
          create: {
            userId,
            url: sourceUrl,
            lastIngestedAt: now,
            lastError: null
          },
          update: {
            url: sourceUrl,
            lastIngestedAt: now,
            lastError: null
          }
        }),
        this.prisma.epgSnapshot.upsert({
          where: {
            userId
          },
          create: {
            userId,
            programsJson: parsed as unknown as Prisma.InputJsonValue,
            lastSuccessfulIngest: now
          },
          update: {
            programsJson: parsed as unknown as Prisma.InputJsonValue,
            lastSuccessfulIngest: now
          }
        })
      ]);

      return parsed;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to ingest XMLTV snapshot';

      this.logger.warn(`XMLTV snapshot refresh failed (${userId}): ${errorMessage}`);

      await this.prisma.epgSource.upsert({
        where: {
          userId
        },
        create: {
          userId,
          url: sourceUrl,
          lastError: errorMessage
        },
        update: {
          url: sourceUrl,
          lastError: errorMessage
        }
      });

      return null;
    }
  }

  private parseStoredXmlTvSnapshot(raw: unknown): XmlTvNowNextSnapshot | null {
    if (!isRecord(raw)) {
      return null;
    }

    const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date(0).toISOString();
    const rawNowNext = isRecord(raw.nowNextByTvgId) ? raw.nowNextByTvgId : {};
    const rawLogos = isRecord(raw.logosByTvgId) ? raw.logosByTvgId : {};

    const nowNextByTvgId: Record<string, { now?: EpgProgram; next?: EpgProgram }> = {};
    for (const [rawChannelTvgId, rawEntry] of Object.entries(rawNowNext)) {
      const channelTvgId = normalizeTvgId(rawChannelTvgId);
      if (!channelTvgId || !isRecord(rawEntry)) {
        continue;
      }

      const now = this.parseStoredProgram(rawEntry.now, channelTvgId);
      const next = this.parseStoredProgram(rawEntry.next, channelTvgId);
      if (!now && !next) {
        continue;
      }

      nowNextByTvgId[channelTvgId] = {
        now,
        next
      };
    }

    const logosByTvgId: Record<string, string> = {};
    for (const [rawChannelTvgId, rawLogo] of Object.entries(rawLogos)) {
      const channelTvgId = normalizeTvgId(rawChannelTvgId);
      if (!channelTvgId || typeof rawLogo !== 'string') {
        continue;
      }

      const logo = rawLogo.trim();
      if (!logo) {
        continue;
      }

      logosByTvgId[channelTvgId] = logo;
    }

    return {
      generatedAt,
      nowNextByTvgId,
      logosByTvgId
    };
  }

  private parseStoredProgram(raw: unknown, channelTvgId: string): EpgProgram | undefined {
    if (!isRecord(raw)) {
      return undefined;
    }

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const start = typeof raw.start === 'string' ? raw.start : '';
    const end = typeof raw.end === 'string' ? raw.end : '';

    if (!title || !start || !end) {
      return undefined;
    }

    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      return undefined;
    }

    return {
      channelTvgId,
      title,
      start,
      end,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      rating: typeof raw.rating === 'string' ? raw.rating : undefined
    };
  }

  private async getEffectiveXmlTvSource(userId: string): Promise<XmlTvSourceRecord> {
    const source = await this.prisma.epgSource.findUnique({
      where: {
        userId
      },
      select: {
        url: true,
        lastIngestedAt: true,
        lastError: true,
        updatedAt: true
      }
    });

    if (source?.url) {
      return {
        url: source.url,
        lastIngestedAt: source.lastIngestedAt,
        lastError: source.lastError,
        updatedAt: source.updatedAt
      };
    }

    return {
      url: this.xmlTvDefaultSourceUrl,
      lastIngestedAt: null,
      lastError: null,
      updatedAt: null
    };
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

  private async getProgramsAndLogosFromOttCatalog(
    userId: string,
    tvgIds: Set<string>
  ): Promise<{ programs: EpgProgram[]; logosByTvgId: Record<string, string> }> {
    const tvgIdsList = [...tvgIds];
    if (tvgIdsList.length === 0) {
      return {
        programs: [],
        logosByTvgId: {}
      };
    }

    const channels = await this.getBestProviderChannels(userId, tvgIdsList);

    if (channels.length === 0) {
      return {
        programs: [],
        logosByTvgId: {}
      };
    }

    const channelsToProbe =
      channels.length > this.ottAutoSyncMaxChannelsPerRequest
        ? (() => {
            // Rotate probe window every minute so we don't keep retrying the same failing channels.
            const offset = Math.floor(Date.now() / 60000) % channels.length;
            return [...channels.slice(offset), ...channels.slice(0, offset)];
          })()
        : channels;

    let syncCount = 0;
    for (const channel of channelsToProbe) {
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

      this.scheduleOttProgramWarmup(userId, channel.id);
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

    const logosByTvgId: Record<string, string> = {};
    for (const channel of channels) {
      if (!channel.tvgId || !channel.logoUrl) {
        continue;
      }

      const normalizedTvgId = normalizeTvgId(channel.tvgId);
      if (!normalizedTvgId) {
        continue;
      }

      if (!logosByTvgId[normalizedTvgId]) {
        logosByTvgId[normalizedTvgId] = channel.logoUrl;
      }
    }

    return {
      programs,
      logosByTvgId
    };
  }

  private scheduleOttProgramWarmup(userId: string, channelId: string): void {
    const warmupKey = `${userId}:${channelId}`;
    if (this.ottProgramsWarmupInFlight.has(warmupKey)) {
      return;
    }

    this.ottProgramsWarmupInFlight.add(warmupKey);
    void this.ottCatalogService
      .syncChannelPrograms(userId, channelId, false)
      .catch(() => {
        // Ignore warmup failures. Endpoint should still return cached data immediately.
      })
      .finally(() => {
        this.ottProgramsWarmupInFlight.delete(warmupKey);
      });
  }

  private scheduleProviderChannelsWarmup(userId: string, providerId: string): void {
    const warmupKey = `${userId}:${providerId}`;
    if (this.ottProviderChannelsWarmupInFlight.has(warmupKey)) {
      return;
    }

    this.ottProviderChannelsWarmupInFlight.add(warmupKey);
    void this.ottCatalogService
      .syncProviderChannels(userId, providerId, false)
      .catch(() => {
        // Ignore warmup failures. Endpoint should still return cached channel map.
      })
      .finally(() => {
        this.ottProviderChannelsWarmupInFlight.delete(warmupKey);
      });
  }

  private async getBestProviderChannels(
    userId: string,
    tvgIdsList: string[]
  ): Promise<OttChannelCandidate[]> {
    const providers = await this.getCandidateProviders(userId);
    if (providers.length === 0) {
      return [];
    }

    const byTvgId = new Map<string, OttChannelCandidate>();

    for (const provider of providers) {
      this.scheduleProviderChannelsWarmup(userId, provider.id);

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
          lastProgramsSyncAt: true,
          logoUrl: true
        }
      });

      for (const channel of channels) {
        if (!channel.tvgId) {
          continue;
        }

        const tvgId = normalizeTvgId(channel.tvgId);
        if (!tvgId) {
          continue;
        }

        const current = byTvgId.get(tvgId);
        if (!current || this.isBetterOttChannelCandidate(channel, current)) {
          byTvgId.set(tvgId, channel);
        }
      }

      if (byTvgId.size >= tvgIdsList.length) {
        break;
      }
    }

    return [...byTvgId.values()];
  }

  private isBetterOttChannelCandidate(next: OttChannelCandidate, current: OttChannelCandidate): boolean {
    if (next.programCount !== current.programCount) {
      return next.programCount > current.programCount;
    }

    const nextSyncAt = next.lastProgramsSyncAt?.getTime() ?? 0;
    const currentSyncAt = current.lastProgramsSyncAt?.getTime() ?? 0;
    if (nextSyncAt !== currentSyncAt) {
      return nextSyncAt > currentSyncAt;
    }

    const nextHasLogo = Boolean(next.logoUrl);
    const currentHasLogo = Boolean(current.logoUrl);
    if (nextHasLogo !== currentHasLogo) {
      return nextHasLogo;
    }

    return false;
  }

  private async getCandidateProviders(
    userId: string
  ): Promise<Array<{ id: string; key: string; lastSyncedAt: Date | null }>> {
    let providers = await this.prisma.ottProvider.findMany({
      where: {
        userId
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
          userId
        },
        select: {
          id: true,
          key: true,
          lastSyncedAt: true
        }
      });
    }

    if (providers.length === 0) {
      return [];
    }

    const providersByKey = new Map<
      string,
      {
        id: string;
        key: string;
        lastSyncedAt: Date | null;
      }
    >();
    for (const provider of providers) {
      providersByKey.set(provider.key.trim().toLowerCase(), provider);
    }

    const preferredProviders = this.ottProviderCandidateKeys
      .map((key) => providersByKey.get(key))
      .filter(
        (provider): provider is { id: string; key: string; lastSyncedAt: Date | null } =>
          Boolean(provider)
      );

    if (!this.ottAutoScanAllProviders) {
      return preferredProviders;
    }

    const preferredIds = new Set(preferredProviders.map((provider) => provider.id));
    const otherProviders = providers
      .filter((provider) => !preferredIds.has(provider.id))
      .sort((a, b) => a.key.localeCompare(b.key));

    const availableSlots = Math.max(this.ottAutoScanProviderLimit - preferredProviders.length, 0);
    if (availableSlots === 0 || otherProviders.length === 0) {
      return preferredProviders.slice(0, this.ottAutoScanProviderLimit);
    }

    const offset = Math.floor(Date.now() / 60000) % otherProviders.length;
    const rotatedOthers = [...otherProviders.slice(offset), ...otherProviders.slice(0, offset)];

    return [...preferredProviders, ...rotatedOthers.slice(0, availableSlots)];
  }
}

