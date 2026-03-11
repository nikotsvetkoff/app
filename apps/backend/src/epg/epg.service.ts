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
  'https://epg.ott-play.com/epgshare/epg_ripper_ALL_SOURCES1.xml.gz';
const IPTV_ORG_GUIDES_URL = 'https://iptv-epg.org/guides';
const IPTV_ORG_GUIDES_LEGACY_URL = 'https://iptv-org.github.io/epg/guides';
const IPTV_ORG_GUIDE_FILE_URL_RE = /https:\/\/iptv-epg\.org\/files\/epg-[a-z0-9-]+\.xml(?:\.gz)?/gi;
const IPTV_ORG_GUIDE_FILENAME_RE = /epg-[a-z0-9-]+\.xml(?:\.gz)?/gi;
const IPTV_ORG_MIN_REFRESH_MS = 6 * 60 * 60 * 1000;
const MIN_ALL_GUIDES_CONCURRENCY = 1;
const MAX_ALL_GUIDES_CONCURRENCY = 12;
const DEFAULT_ALL_GUIDES_CONCURRENCY = 4;
const OTT_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const OTT_TIME_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
const XMLTV_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
};
const MAX_XMLTV_UPLOAD_BYTES = 80_000_000;
const MAX_XMLTV_SOURCE_URLS = 24;
const XMLTV_CHANNEL_NAME_LOOKUP_TTL_MS = 30 * 60 * 1000;
const CHANNEL_NAME_QUALITY_TOKENS = new Set(['hd', 'uhd', 'fhd', 'sd', '4k', 'hevc', 'hdr']);
const CHANNEL_NAME_REGION_TOKENS = new Set([
  'md',
  'ro',
  'ru',
  'ua',
  'uk',
  'us',
  'de',
  'fr',
  'it',
  'es',
  'pt',
  'tr',
  'bg',
  'pl',
  'cz',
  'sk',
  'hu',
  'gr',
  'rs',
  'ba',
  'al',
  'mk',
  'si',
  'hr',
  'lt',
  'lv',
  'ee',
  'il',
  'ca',
  'au',
  'nz',
  'se',
  'no',
  'fi',
  'dk',
  'be',
  'nl',
  'ch',
  'at',
  'ie'
]);

const toInt = (raw: string): number => Number.parseInt(raw, 10);
const normalizeTvgId = (raw: string): string => raw.trim().toLowerCase();
const normalizeChannelName = (raw: string, removeRegionTokens = false): string => {
  const base = raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  let tokens = base.split(/\s+/).filter(Boolean);
  tokens = tokens.filter((token) => !CHANNEL_NAME_QUALITY_TOKENS.has(token));
  if (removeRegionTokens) {
    tokens = tokens.filter((token) => !CHANNEL_NAME_REGION_TOKENS.has(token));
  }

  if (tokens.length >= 4 && tokens.length % 2 === 0) {
    const half = tokens.length / 2;
    const left = tokens.slice(0, half).join(' ');
    const right = tokens.slice(half).join(' ');
    if (left === right) {
      tokens = tokens.slice(0, half);
    }
  }

  return tokens.join(' ').trim();
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface NowNextEntry {
  now?: EpgProgram;
  next?: EpgProgram;
}

interface XmlTvSourceRecord {
  url: string;
  urls: string[];
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

interface UploadedXmlTvGzipFile {
  buffer: Buffer;
  originalname?: string;
  size?: number;
  mimetype?: string;
}

interface XmlTvChannelNameLookup {
  strict: Map<string, string>;
  loose: Map<string, string>;
}

interface XmlTvChannelNameLookupCacheEntry extends XmlTvChannelNameLookup {
  generatedAt: string;
  expiresAtMs: number;
}

interface OttChannelNameLookup {
  strict: Map<string, string>;
  loose: Map<string, string>;
}

interface OttChannelNameLookupCacheEntry extends OttChannelNameLookup {
  expiresAtMs: number;
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
  private readonly xmlTvAllGuidesConcurrency: number;
  private readonly xmlTvRetryAfterFailureMs: number;
  private readonly xmlTvExtraSourceUrls: string[];
  private readonly xmlTvRefreshInFlight = new Map<string, Promise<XmlTvNowNextSnapshot | null>>();
  private readonly xmlTvChannelNameLookupCache = new Map<string, XmlTvChannelNameLookupCacheEntry>();
  private readonly ottChannelNameLookupCache = new Map<string, OttChannelNameLookupCacheEntry>();

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

    const configuredXmlTvUrlRaw = String(
      this.configService.get('EPG_XMLTV_SOURCE_URL') ??
        this.configService.get('EPG_XMLTV_URL') ??
        DEFAULT_XMLTV_SOURCE_URL
    )
      .trim()
      .replace(/\s+/g, '');
    const configuredXmlTvUrl = this.normalizeXmlTvSourceUrl(configuredXmlTvUrlRaw);
    const configuredXmlTvExtraSourceUrls = this.parseXmlTvSourceUrls(
      String(this.configService.get('EPG_XMLTV_EXTRA_SOURCE_URLS') ?? '')
    ).filter((url) => url !== configuredXmlTvUrl);

    this.xmlTvDefaultSourceUrl = configuredXmlTvUrl || DEFAULT_XMLTV_SOURCE_URL;
    this.xmlTvExtraSourceUrls = configuredXmlTvExtraSourceUrls.filter((url) => {
      if (!this.isXmlSnapshotIngestAllowed(url)) {
        return false;
      }
      if (this.isIptvOrgAllSourceUrl(url)) {
        return true;
      }
      try {
        assertSafeHttpUrl(url);
        return true;
      } catch {
        return false;
      }
    });
    this.xmlTvSnapshotTtlMs = Number(this.configService.get('EPG_XMLTV_SNAPSHOT_TTL_SEC') ?? 1800) * 1000;
    this.xmlTvFetchTimeoutMs = Number(this.configService.get('EPG_XMLTV_FETCH_TIMEOUT_MS') ?? 240000);
    this.xmlTvFetchRetries = Number(this.configService.get('EPG_XMLTV_FETCH_RETRIES') ?? 1);
    this.xmlTvAllGuidesConcurrency = Math.max(
      MIN_ALL_GUIDES_CONCURRENCY,
      Math.min(
        MAX_ALL_GUIDES_CONCURRENCY,
        Number(this.configService.get('EPG_XMLTV_ALL_GUIDES_CONCURRENCY') ?? DEFAULT_ALL_GUIDES_CONCURRENCY)
      )
    );
    this.xmlTvRetryAfterFailureMs =
      Number(this.configService.get('EPG_XMLTV_RETRY_AFTER_FAILURE_SEC') ?? 300) * 1000;
  }

  async setEpgUrl(userId: string, rawUrl: string): Promise<{ success: true }> {
    const sourceUrls = this.parseXmlTvSourceUrls(rawUrl);
    if (sourceUrls.length === 0) {
      throw new BadRequestException('Introdu cel putin un URL EPG valid.');
    }
    if (sourceUrls.length > MAX_XMLTV_SOURCE_URLS) {
      throw new BadRequestException(`Prea multe surse EPG. Maxim ${MAX_XMLTV_SOURCE_URLS}.`);
    }

    const safeUrls = sourceUrls.map((sourceUrl) => {
      if (!this.isXmlSnapshotIngestAllowed(sourceUrl)) {
        throw new BadRequestException(`Sursa EPG nu este suportata: ${sourceUrl}`);
      }
      if (this.isIptvOrgAllSourceUrl(sourceUrl)) {
        return sourceUrl;
      }
      return assertSafeHttpUrl(sourceUrl).toString();
    });
    const serializedSourceUrls = this.serializeXmlTvSourceUrls(safeUrls);

    await this.prisma.epgSource.upsert({
      where: {
        userId
      },
      create: {
        userId,
        url: serializedSourceUrls,
        lastIngestedAt: null,
        lastError: null
      },
      update: {
        url: serializedSourceUrls,
        lastIngestedAt: null,
        lastError: null
      }
    });

    return { success: true };
  }

  async uploadXmlTvGzip(
    userId: string,
    file: UploadedXmlTvGzipFile | undefined
  ): Promise<{
    success: true;
    sourceUrl: string;
    fileName: string;
    snapshotGeneratedAt: string;
    snapshotChannels: number;
  }> {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Selecteaza fisierul EPG .gz.');
    }

    if (file.buffer.length > MAX_XMLTV_UPLOAD_BYTES) {
      throw new BadRequestException('Fisierul EPG este prea mare. Maxim 80 MB.');
    }

    const normalizedFileName = this.sanitizeUploadFileName(file.originalname);
    if (!normalizedFileName.toLowerCase().endsWith('.gz')) {
      throw new BadRequestException('Fisierul EPG trebuie sa fie .gz.');
    }

    let parsed: XmlTvNowNextSnapshot;
    try {
      parsed = await parseXmlTvNowNextSnapshot(
        new Response(new Uint8Array(file.buffer), {
          headers: {
            'content-type': 'application/gzip',
            'content-encoding': 'gzip'
          }
        }),
        {
          assumeGzip: true
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid XMLTV gzip file';
      throw new BadRequestException(`EPG upload failed: ${errorMessage}`);
    }

    const now = new Date();
    const sourceUrl = this.buildUploadedXmlTvSourceUrl(normalizedFileName);

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

    return {
      success: true,
      sourceUrl,
      fileName: normalizedFileName,
      snapshotGeneratedAt: parsed.generatedAt,
      snapshotChannels: Object.keys(parsed.nowNextByTvgId).length
    };
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
    const xmlSnapshotAllowed = source.urls.some((url) => this.isXmlSnapshotIngestAllowed(url));

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

    const [xmlTvSnapshot, ottChannelNameLookup] = await Promise.all([
      this.getXmlTvSnapshot(device.userId),
      this.getOttChannelNameLookup(device.userId)
    ]);
    const channelNameLookup = this.getXmlTvChannelNameLookup(device.userId, xmlTvSnapshot);
    const resolvedTvgIdsByChannelId = this.resolveDeviceChannelsTvgIds(
      channels,
      channelNameLookup,
      ottChannelNameLookup
    );
    const requestedTvgIdsNormalized = new Set([...resolvedTvgIdsByChannelId.values()]);

    const ottData = await this.getProgramsAndLogosFromOttCatalog(device.userId, requestedTvgIdsNormalized);
    const { programs, logosByTvgId: ottLogosByTvgId } = ottData;

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
      const resolvedTvgId = resolvedTvgIdsByChannelId.get(channel.id) ?? '';
      const xmlEntry = resolvedTvgId ? xmlTvSnapshot?.nowNextByTvgId[resolvedTvgId] : undefined;
      const ottEntry = resolvedTvgId ? ottMappedNormalized.get(resolvedTvgId) : undefined;
      const explicitTvgId = typeof channel.tvgId === 'string' ? channel.tvgId.trim() : '';

      return {
        channelId: channel.id,
        channelTvgId: explicitTvgId || resolvedTvgId || undefined,
        channelLogo: resolvedTvgId
          ? (xmlTvSnapshot?.logosByTvgId[resolvedTvgId] ?? ottLogosByTvgId[resolvedTvgId])
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

    const [xmlTvSnapshot, ottChannelNameLookup] = await Promise.all([
      this.getXmlTvSnapshot(device.userId),
      this.getOttChannelNameLookup(device.userId)
    ]);
    const channelNameLookup = this.getXmlTvChannelNameLookup(device.userId, xmlTvSnapshot);
    const resolvedTvgIdsByChannelId = this.resolveDeviceChannelsTvgIds(
      channels,
      channelNameLookup,
      ottChannelNameLookup
    );
    const requestedTvgIdsNormalized = new Set([...resolvedTvgIdsByChannelId.values()]);
    if (requestedTvgIdsNormalized.size === 0) {
      return [];
    }

    const { programs } = await this.getProgramsAndLogosFromOttCatalog(
      device.userId,
      requestedTvgIdsNormalized
    );
    const dayPrograms = filterProgramsByDay(programs, day);

    const response = new Map<string, EpgProgram[]>();

    for (const program of dayPrograms) {
      const normalizedProgramTvgId = normalizeTvgId(program.channelTvgId);
      if (!requestedTvgIdsNormalized.has(normalizedProgramTvgId)) {
        continue;
      }
      const existing = response.get(normalizedProgramTvgId) ?? [];
      existing.push(program);
      response.set(normalizedProgramTvgId, existing);
    }

    return [...response.entries()].map(([channelTvgId, programsList]) => ({
      channelTvgId,
      programs: programsList
    }));
  }

  private resolveDeviceChannelsTvgIds(
    channels: Channel[],
    xmlLookup: XmlTvChannelNameLookup,
    ottLookup: OttChannelNameLookup
  ): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const channel of channels) {
      const directTvgId = normalizeTvgId(channel.tvgId ?? '');
      const resolvedTvgId =
        directTvgId ||
        this.resolveChannelTvgIdFromXmlNameLookup(channel.name, xmlLookup) ||
        this.resolveChannelTvgIdFromOttNameLookup(channel.name, ottLookup) ||
        '';
      if (!resolvedTvgId) {
        continue;
      }
      resolved.set(channel.id, resolvedTvgId);
    }
    return resolved;
  }

  private resolveChannelTvgIdFromXmlNameLookup(
    channelName: string,
    lookup: XmlTvChannelNameLookup
  ): string | undefined {
    const strictKey = normalizeChannelName(channelName, false);
    if (strictKey) {
      const strictMatch = lookup.strict.get(strictKey);
      if (strictMatch) {
        return strictMatch;
      }
    }

    const looseKey = normalizeChannelName(channelName, true);
    if (!looseKey) {
      return undefined;
    }

    return lookup.loose.get(looseKey);
  }

  private resolveChannelTvgIdFromOttNameLookup(
    channelName: string,
    lookup: OttChannelNameLookup
  ): string | undefined {
    const strictKey = normalizeChannelName(channelName, false);
    if (strictKey) {
      const strictMatch = lookup.strict.get(strictKey);
      if (strictMatch) {
        return strictMatch;
      }
    }

    const looseKey = normalizeChannelName(channelName, true);
    if (!looseKey) {
      return undefined;
    }

    return lookup.loose.get(looseKey);
  }

  private async getOttChannelNameLookup(userId: string): Promise<OttChannelNameLookup> {
    const emptyLookup: OttChannelNameLookup = {
      strict: new Map<string, string>(),
      loose: new Map<string, string>()
    };

    const nowMs = Date.now();
    const cached = this.ottChannelNameLookupCache.get(userId);
    if (cached && cached.expiresAtMs > nowMs) {
      return {
        strict: cached.strict,
        loose: cached.loose
      };
    }

    const rows = await this.prisma.ottChannel.findMany({
      where: {
        userId,
        tvgId: {
          not: null
        }
      },
      select: {
        displayName: true,
        tvgId: true
      }
    });
    if (rows.length === 0) {
      this.ottChannelNameLookupCache.set(userId, {
        strict: new Map<string, string>(),
        loose: new Map<string, string>(),
        expiresAtMs: nowMs + XMLTV_CHANNEL_NAME_LOOKUP_TTL_MS
      });
      return emptyLookup;
    }

    const strictCandidates = new Map<string, Set<string>>();
    const looseCandidates = new Map<string, Set<string>>();
    for (const row of rows) {
      const tvgId = normalizeTvgId(row.tvgId ?? '');
      if (!tvgId) {
        continue;
      }

      const strictKey = normalizeChannelName(row.displayName, false);
      if (strictKey) {
        const strictSet = strictCandidates.get(strictKey) ?? new Set<string>();
        strictSet.add(tvgId);
        strictCandidates.set(strictKey, strictSet);
      }

      const looseKey = normalizeChannelName(row.displayName, true);
      if (looseKey) {
        const looseSet = looseCandidates.get(looseKey) ?? new Set<string>();
        looseSet.add(tvgId);
        looseCandidates.set(looseKey, looseSet);
      }
    }

    const strict = this.toUniqueNameLookup(strictCandidates);
    const loose = this.toUniqueNameLookup(looseCandidates);
    this.ottChannelNameLookupCache.set(userId, {
      strict,
      loose,
      expiresAtMs: nowMs + XMLTV_CHANNEL_NAME_LOOKUP_TTL_MS
    });

    return {
      strict,
      loose
    };
  }

  private getXmlTvChannelNameLookup(
    userId: string,
    snapshot: XmlTvNowNextSnapshot | null
  ): XmlTvChannelNameLookup {
    const emptyLookup: XmlTvChannelNameLookup = {
      strict: new Map<string, string>(),
      loose: new Map<string, string>()
    };
    if (!snapshot) {
      return emptyLookup;
    }

    const nowMs = Date.now();
    const cached = this.xmlTvChannelNameLookupCache.get(userId);
    if (
      cached &&
      cached.generatedAt === snapshot.generatedAt &&
      cached.expiresAtMs > nowMs
    ) {
      return {
        strict: cached.strict,
        loose: cached.loose
      };
    }

    const strictCandidates = new Map<string, Set<string>>();
    const looseCandidates = new Map<string, Set<string>>();
    for (const [rawTvgId, rawNames] of Object.entries(snapshot.channelNamesByTvgId ?? {})) {
      const tvgId = normalizeTvgId(rawTvgId);
      if (!tvgId || !Array.isArray(rawNames) || rawNames.length === 0) {
        continue;
      }

      for (const rawName of rawNames) {
        if (typeof rawName !== 'string') {
          continue;
        }

        const strictKey = normalizeChannelName(rawName, false);
        if (strictKey) {
          const strictSet = strictCandidates.get(strictKey) ?? new Set<string>();
          strictSet.add(tvgId);
          strictCandidates.set(strictKey, strictSet);
        }

        const looseKey = normalizeChannelName(rawName, true);
        if (looseKey) {
          const looseSet = looseCandidates.get(looseKey) ?? new Set<string>();
          looseSet.add(tvgId);
          looseCandidates.set(looseKey, looseSet);
        }
      }
    }

    const strict = this.toUniqueNameLookup(strictCandidates);
    const loose = this.toUniqueNameLookup(looseCandidates);
    this.xmlTvChannelNameLookupCache.set(userId, {
      generatedAt: snapshot.generatedAt,
      strict,
      loose,
      expiresAtMs: nowMs + XMLTV_CHANNEL_NAME_LOOKUP_TTL_MS
    });

    return {
      strict,
      loose
    };
  }

  private toUniqueNameLookup(candidates: Map<string, Set<string>>): Map<string, string> {
    const result = new Map<string, string>();
    for (const [key, values] of candidates.entries()) {
      if (values.size !== 1) {
        continue;
      }
      const [onlyValue] = [...values];
      if (!onlyValue) {
        continue;
      }
      result.set(key, onlyValue);
    }
    return result;
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
    const effectiveSnapshotTtlMs = source.urls.some((url) => this.isIptvOrgAllSourceUrl(url))
      ? Math.max(this.xmlTvSnapshotTtlMs, IPTV_ORG_MIN_REFRESH_MS)
      : this.xmlTvSnapshotTtlMs;
    const sourceChangedAfterSnapshot =
      Boolean(source.updatedAt && snapshotRow?.updatedAt) &&
      (source.updatedAt?.getTime() ?? 0) > (snapshotRow?.updatedAt.getTime() ?? 0);
    const isFresh =
      Boolean(snapshotRow && cachedSnapshot) &&
      !sourceChangedAfterSnapshot &&
      Date.now() - (snapshotRow?.updatedAt.getTime() ?? 0) <= effectiveSnapshotTtlMs;

    if (isFresh) {
      return cachedSnapshot;
    }

    if (!source.urls.some((url) => this.isXmlSnapshotIngestAllowed(url))) {
      return cachedSnapshot;
    }

    const hasRecentFailure =
      Boolean(source.lastError && source.updatedAt) &&
      Date.now() - (source.updatedAt?.getTime() ?? 0) <= this.xmlTvRetryAfterFailureMs;
    if (hasRecentFailure) {
      return cachedSnapshot;
    }

    const refreshedSnapshot = await this.refreshXmlTvSnapshotLocked(userId, source.urls);
    return refreshedSnapshot ?? cachedSnapshot;
  }

  private isXmlSnapshotIngestAllowed(sourceUrl: string): boolean {
    const normalized = this.normalizeXmlTvSourceUrl(sourceUrl).trim();
    if (!normalized) {
      return false;
    }

    if (this.isIptvOrgAllSourceUrl(normalized)) {
      return true;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalized);
    } catch {
      return false;
    }

    const protocol = parsedUrl.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return false;
    }

    const normalizedHref = parsedUrl.href.toLowerCase();

    // ott-play show_prow endpoint renders HTML table, not XMLTV snapshot.
    if (normalizedHref.includes('/php/show_prow.php')) {
      return false;
    }

    return true;
  }

  private normalizeXmlTvSourceUrl(rawSourceUrl: string): string {
    const raw = String(rawSourceUrl ?? '').trim();
    if (!raw) {
      return '';
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(raw);
    } catch {
      return raw;
    }

    const normalizedHost = parsedUrl.hostname.trim().toLowerCase();
    const normalizedPath = parsedUrl.pathname.trim().toLowerCase();
    if (normalizedHost === 'epg.ott-play.com' && normalizedPath === '/php/show_prow.php') {
      const filePath = (parsedUrl.searchParams.get('f') ?? '').trim();
      if (filePath) {
        const normalizedFilePath = filePath.replace(/^[./]+/, '').replace(/^\/+/, '');
        if (normalizedFilePath) {
          try {
            return new URL(`/${normalizedFilePath}`, OTT_BASE_URL).toString();
          } catch {
            return raw;
          }
        }
      }
    }

    return parsedUrl.toString();
  }

  private isIptvOrgAllSourceUrl(sourceUrl: string): boolean {
    const normalized = sourceUrl.trim().toLowerCase().replace(/\/+$/, '');
    return normalized === IPTV_ORG_GUIDES_URL || normalized === IPTV_ORG_GUIDES_LEGACY_URL;
  }

  private buildUploadedXmlTvSourceUrl(fileName: string): string {
    return `uploaded://${fileName}`;
  }

  private sanitizeUploadFileName(rawName: string | undefined): string {
    const fallback = `epg-upload-${Date.now()}.xml.gz`;
    if (!rawName) {
      return fallback;
    }

    const normalized = rawName
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    return normalized || fallback;
  }

  private async refreshXmlTvSnapshotLocked(
    userId: string,
    sourceUrls: string[]
  ): Promise<XmlTvNowNextSnapshot | null> {
    const inFlight = this.xmlTvRefreshInFlight.get(userId);
    if (inFlight) {
      return inFlight;
    }

    const task = this.refreshXmlTvSnapshot(userId, sourceUrls).finally(() => {
      this.xmlTvRefreshInFlight.delete(userId);
    });

    this.xmlTvRefreshInFlight.set(userId, task);
    return task;
  }

  private async refreshXmlTvSnapshot(
    userId: string,
    sourceUrls: string[]
  ): Promise<XmlTvNowNextSnapshot | null> {
    const persistedSourceValue = this.serializeXmlTvSourceUrls(sourceUrls);

    try {
      const mergedNowNextByTvgId: Record<string, { now?: EpgProgram; next?: EpgProgram }> = {};
      const mergedLogosByTvgId: Record<string, string> = {};
      const mergedChannelNamesByTvgId: Record<string, string[]> = {};

      let successCount = 0;
      const failedSources: string[] = [];

      for (const sourceUrl of sourceUrls) {
        if (!this.isXmlSnapshotIngestAllowed(sourceUrl)) {
          continue;
        }

        try {
          const parsed = this.isIptvOrgAllSourceUrl(sourceUrl)
            ? await this.refreshIptvOrgAllSnapshot(sourceUrl)
            : await this.refreshSingleXmlTvSnapshot(sourceUrl);
          this.mergeXmlTvNowNextSnapshot(
            mergedNowNextByTvgId,
            mergedLogosByTvgId,
            mergedChannelNamesByTvgId,
            parsed
          );
          successCount += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'unknown error';
          failedSources.push(`${sourceUrl}: ${message}`);
        }
      }

      if (successCount === 0) {
        const details = failedSources.join(' | ') || 'No valid XMLTV sources configured.';
        throw new BadRequestException(`Nu s-a putut incarca niciuna dintre sursele EPG. ${details}`);
      }

      if (failedSources.length > 0) {
        this.logger.warn(`XMLTV partial refresh for ${userId}: ${failedSources.join(' | ')}`);
      }

      const parsed: XmlTvNowNextSnapshot = {
        generatedAt: new Date().toISOString(),
        nowNextByTvgId: mergedNowNextByTvgId,
        logosByTvgId: mergedLogosByTvgId,
        channelNamesByTvgId: mergedChannelNamesByTvgId
      };

      const now = new Date();

      await this.prisma.$transaction([
        this.prisma.epgSource.upsert({
          where: {
            userId
          },
          create: {
            userId,
            url: persistedSourceValue,
            lastIngestedAt: now,
            lastError: null
          },
          update: {
            url: persistedSourceValue,
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
          url: persistedSourceValue,
          lastError: errorMessage
        },
        update: {
          url: persistedSourceValue,
          lastError: errorMessage
        }
      });

      return null;
    }
  }

  private async refreshSingleXmlTvSnapshot(sourceUrl: string): Promise<XmlTvNowNextSnapshot> {
    const response = await fetchWithRetry(sourceUrl, {
      timeoutMs: this.xmlTvFetchTimeoutMs,
      retries: this.xmlTvFetchRetries,
      backoffMs: 1500,
      headers: XMLTV_HEADERS
    });

    return parseXmlTvNowNextSnapshot(response, {
      assumeGzip: sourceUrl.toLowerCase().includes('.gz')
    });
  }

  private async refreshIptvOrgAllSnapshot(sourceUrl: string): Promise<XmlTvNowNextSnapshot> {
    const guideUrls = await this.fetchIptvOrgGuideUrls(sourceUrl);
    const mergedNowNextByTvgId: Record<string, { now?: EpgProgram; next?: EpgProgram }> = {};
    const mergedLogosByTvgId: Record<string, string> = {};
    const mergedChannelNamesByTvgId: Record<string, string[]> = {};

    let successCount = 0;
    let failedCount = 0;
    const queue = [...guideUrls];
    const workerCount = Math.min(this.xmlTvAllGuidesConcurrency, queue.length);

    this.logger.log(
      `IPTV-ORG all snapshot: loading ${guideUrls.length} guides with concurrency ${workerCount}`
    );

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const guideUrl = queue.shift();
          if (!guideUrl) {
            continue;
          }

          try {
            const response = await fetchWithRetry(guideUrl, {
              timeoutMs: this.xmlTvFetchTimeoutMs,
              retries: this.xmlTvFetchRetries,
              backoffMs: 1500,
              headers: XMLTV_HEADERS
            });

            const parsed = await parseXmlTvNowNextSnapshot(response, {
              assumeGzip: true
            });
            this.mergeXmlTvNowNextSnapshot(
              mergedNowNextByTvgId,
              mergedLogosByTvgId,
              mergedChannelNamesByTvgId,
              parsed
            );
            successCount += 1;
          } catch (error) {
            failedCount += 1;
            const message = error instanceof Error ? error.message : 'unknown error';
            this.logger.warn(`IPTV-ORG guide fetch failed (${guideUrl}): ${message}`);
          }
        }
      })
    );

    if (successCount === 0) {
      throw new BadRequestException('Nu s-a putut incarca niciun ghid IPTV-ORG.');
    }

    this.logger.log(
      `IPTV-ORG all snapshot refreshed: ${successCount} guides loaded, ${failedCount} failed, ${Object.keys(
        mergedNowNextByTvgId
      ).length} channels with now/next`
    );

    return {
      generatedAt: new Date().toISOString(),
      nowNextByTvgId: mergedNowNextByTvgId,
      logosByTvgId: mergedLogosByTvgId,
      channelNamesByTvgId: mergedChannelNamesByTvgId
    };
  }

  private async fetchIptvOrgGuideUrls(sourceUrl: string): Promise<string[]> {
    const primaryUrl = sourceUrl.trim().replace(/\/+$/, '');
    const normalizedPrimary = primaryUrl.toLowerCase();
    const fallbackUrl =
      normalizedPrimary === IPTV_ORG_GUIDES_URL ? IPTV_ORG_GUIDES_LEGACY_URL : IPTV_ORG_GUIDES_URL;

    const candidatePages = [...new Set([primaryUrl, fallbackUrl])];
    let html = '';

    for (const pageUrl of candidatePages) {
      try {
        const response = await fetchWithRetry(pageUrl, {
          timeoutMs: this.xmlTvFetchTimeoutMs,
          retries: this.xmlTvFetchRetries,
          backoffMs: 1500,
          headers: {
            ...XMLTV_HEADERS,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        html = await response.text();
        if (html.trim()) {
          break;
        }
      } catch {
        // try the next mirror
      }
    }

    if (!html.trim()) {
      throw new BadRequestException('Nu s-a putut citi pagina cu ghiduri IPTV-ORG.');
    }

    const absoluteMatches = html.match(IPTV_ORG_GUIDE_FILE_URL_RE) ?? [];
    const fileNameMatches = html.match(IPTV_ORG_GUIDE_FILENAME_RE) ?? [];
    const matches = [
      ...absoluteMatches,
      ...fileNameMatches.map((fileName) => `https://iptv-epg.org/files/${fileName}`)
    ];
    const uniqueGuideUrls = [
      ...new Set(
        matches
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => (value.toLowerCase().endsWith('.gz') ? value : `${value}.gz`))
      )
    ].sort((a, b) => a.localeCompare(b));

    if (uniqueGuideUrls.length === 0) {
      throw new BadRequestException('Lista IPTV-ORG nu contine ghiduri XMLTV detectabile.');
    }

    return uniqueGuideUrls;
  }

  private mergeXmlTvNowNextSnapshot(
    targetNowNextByTvgId: Record<string, { now?: EpgProgram; next?: EpgProgram }>,
    targetLogosByTvgId: Record<string, string>,
    targetChannelNamesByTvgId: Record<string, string[]>,
    incoming: XmlTvNowNextSnapshot
  ): void {
    for (const [rawTvgId, rawEntry] of Object.entries(incoming.nowNextByTvgId ?? {})) {
      const tvgId = normalizeTvgId(rawTvgId);
      if (!tvgId || !rawEntry) {
        continue;
      }

      const existing = targetNowNextByTvgId[tvgId] ?? {};
      const existingScore = (existing.now ? 2 : 0) + (existing.next ? 1 : 0);
      const incomingScore = (rawEntry.now ? 2 : 0) + (rawEntry.next ? 1 : 0);

      if (incomingScore > existingScore) {
        targetNowNextByTvgId[tvgId] = {
          now: rawEntry.now ?? existing.now,
          next: rawEntry.next ?? existing.next
        };
        continue;
      }

      targetNowNextByTvgId[tvgId] = {
        now: existing.now ?? rawEntry.now,
        next: existing.next ?? rawEntry.next
      };
    }

    for (const [rawTvgId, rawLogo] of Object.entries(incoming.logosByTvgId ?? {})) {
      const tvgId = normalizeTvgId(rawTvgId);
      if (!tvgId || !rawLogo) {
        continue;
      }
      if (!targetLogosByTvgId[tvgId]) {
        targetLogosByTvgId[tvgId] = rawLogo;
      }
    }

    for (const [rawTvgId, rawNames] of Object.entries(incoming.channelNamesByTvgId ?? {})) {
      const tvgId = normalizeTvgId(rawTvgId);
      if (!tvgId || !Array.isArray(rawNames) || rawNames.length === 0) {
        continue;
      }

      const merged = new Set<string>(
        (targetChannelNamesByTvgId[tvgId] ?? []).filter((value) => typeof value === 'string')
      );
      for (const rawName of rawNames) {
        if (typeof rawName !== 'string') {
          continue;
        }
        const value = rawName.trim();
        if (value) {
          merged.add(value);
        }
      }

      if (merged.size > 0) {
        targetChannelNamesByTvgId[tvgId] = [...merged];
      }
    }
  }

  private parseStoredXmlTvSnapshot(raw: unknown): XmlTvNowNextSnapshot | null {
    if (!isRecord(raw)) {
      return null;
    }

    const generatedAt = typeof raw.generatedAt === 'string' ? raw.generatedAt : new Date(0).toISOString();
    const rawNowNext = isRecord(raw.nowNextByTvgId) ? raw.nowNextByTvgId : {};
    const rawLogos = isRecord(raw.logosByTvgId) ? raw.logosByTvgId : {};
    const rawChannelNames = isRecord(raw.channelNamesByTvgId) ? raw.channelNamesByTvgId : {};

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

    const channelNamesByTvgId: Record<string, string[]> = {};
    for (const [rawChannelTvgId, rawNames] of Object.entries(rawChannelNames)) {
      const channelTvgId = normalizeTvgId(rawChannelTvgId);
      if (!channelTvgId || !Array.isArray(rawNames)) {
        continue;
      }

      const normalized = rawNames
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
      if (normalized.length === 0) {
        continue;
      }

      channelNamesByTvgId[channelTvgId] = [...new Set(normalized)];
    }

    return {
      generatedAt,
      nowNextByTvgId,
      logosByTvgId,
      channelNamesByTvgId
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
    const defaultUrls = this.buildDefaultXmlTvSourceUrls();
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
      const normalizedSourceUrls = this.parseXmlTvSourceUrls(source.url);
      const effectiveUrls = normalizedSourceUrls.length > 0 ? normalizedSourceUrls : defaultUrls;
      return {
        url: this.serializeXmlTvSourceUrls(effectiveUrls),
        urls: effectiveUrls,
        lastIngestedAt: source.lastIngestedAt,
        lastError: source.lastError,
        updatedAt: source.updatedAt
      };
    }

    return {
      url: this.serializeXmlTvSourceUrls(defaultUrls),
      urls: defaultUrls,
      lastIngestedAt: null,
      lastError: null,
      updatedAt: null
    };
  }

  private buildDefaultXmlTvSourceUrls(): string[] {
    const merged = [this.xmlTvDefaultSourceUrl, ...this.xmlTvExtraSourceUrls]
      .map((value) => value.trim())
      .filter(Boolean);

    return [...new Set(merged)].slice(0, MAX_XMLTV_SOURCE_URLS);
  }

  private serializeXmlTvSourceUrls(urls: string[]): string {
    const normalized = [...new Set(urls.map((value) => value.trim()).filter(Boolean))].slice(
      0,
      MAX_XMLTV_SOURCE_URLS
    );
    return normalized.join('\n');
  }

  private parseXmlTvSourceUrls(rawSourceValue: string): string[] {
    const rawInput = String(rawSourceValue ?? '').trim();
    if (!rawInput) {
      return [];
    }

    const httpLikeMatches = rawInput.match(/https?:\/\/\S+/gi);
    const rawCandidates =
      httpLikeMatches && httpLikeMatches.length > 1
        ? httpLikeMatches
        : rawInput
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean);

    const normalized = new Set<string>();

    for (const rawCandidate of rawCandidates) {
      const trimmed = rawCandidate.trim().replace(/^[,;]+|[,;]+$/g, '');
      if (!trimmed) {
        continue;
      }

      const normalizedUrl = this.normalizeXmlTvSourceUrl(trimmed);
      if (!normalizedUrl) {
        continue;
      }

      normalized.add(normalizedUrl);
      if (normalized.size >= MAX_XMLTV_SOURCE_URLS) {
        break;
      }
    }

    return [...normalized];
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

