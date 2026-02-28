import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel } from '@iptv/core';
import { buildChannelId, parseM3u } from '@iptv/core';
import { Prisma } from '@prisma/client';
import { fetchTextWithRetry } from '../common/http.util';
import { assertSafeHttpUrl } from '../common/url-safety.util';
import { OttCatalogService } from '../ott-catalog/ott-catalog.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateBasePlaylistDto } from './dto/update-base-playlist.dto';

const parseChannelsJson = (raw: unknown): Channel[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw as Channel[];
};

const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;
const QUALITY_TOKENS = new Set(['uhd', 'fhd', 'hd', 'sd', '4k', 'hevc', 'h265', 'hdr', 'dovi']);
const LEGACY_SOURCE_PLACEHOLDER_URL = 'https://example.com/playlist.m3u8';

interface OttChannelCandidate {
  tvgId?: string;
  logo?: string;
}

interface OttChannelLookupRow {
  displayName: string;
  tvgId: string | null;
  logoUrl: string | null;
}

interface BasePlaylistWithCacheRow {
  id: string;
  name: string;
  url: string;
  lastFetchedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  cache: {
    channelsJson: unknown;
    updatedAt: Date;
    lastSuccessfulFetchAt: Date | null;
  } | null;
}

interface BasePlaylistIdentityRow {
  id: string;
  name: string;
  url: string;
}

export interface BasePlaylistListItem {
  id: string;
  name: string;
  url: string;
  channelsCount: number;
  cacheUpdatedAt: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistChannelItem {
  id: string;
  name: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  url: string;
  position: number;
  sourcePlaylistIds: string[];
  sourcePlaylistNames: string[];
}

export interface CustomPlaylistListItem {
  id: string;
  name: string;
  channelsCount: number;
  isActive: boolean;
  sourcePlaylistIds: string[];
  sourcePlaylistNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomPlaylistDetailItem extends CustomPlaylistListItem {
  channels: PlaylistChannelItem[];
}

const normalizeChannelName = (raw: string): string =>
  raw
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(NON_WORD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeChannelNameNoQuality = (raw: string): string =>
  normalizeChannelName(raw)
    .split(' ')
    .filter((token) => Boolean(token) && !QUALITY_TOKENS.has(token))
    .join(' ')
    .trim();

const normalizeTvgId = (raw: string | null | undefined): string => (raw ?? '').trim().toLowerCase();

const pushLookupCandidate = (
  lookup: Map<string, OttChannelCandidate[]>,
  key: string,
  candidate: OttChannelCandidate
): void => {
  if (!key) {
    return;
  }

  const existing = lookup.get(key);
  if (existing) {
    existing.push(candidate);
    return;
  }

  lookup.set(key, [candidate]);
};

const countHttpSchemes = (value: string): number => {
  const matches = value.match(/https?:\/\//gi);
  return matches ? matches.length : 0;
};

@Injectable()
export class PlaylistService {
  private readonly cacheTtlMs: number;
  private readonly ottDefaultProviderKey: string;
  private readonly ottCandidateProviderKeys: string[];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OttCatalogService) private readonly ottCatalogService: OttCatalogService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {
    this.cacheTtlMs = Number(this.configService.get('PLAYLIST_CACHE_TTL_SEC') ?? 900) * 1000;
    this.ottDefaultProviderKey = String(
      this.configService.get('OTT_DEFAULT_PROVIDER_KEY') ?? 'cbilling'
    )
      .trim()
      .toLowerCase();
    this.ottCandidateProviderKeys = [
      ...new Set([
        this.ottDefaultProviderKey,
        ...String(this.configService.get('OTT_FALLBACK_PROVIDER_KEYS') ?? 'edem')
          .split(',')
          .map((key) => key.trim().toLowerCase())
          .filter(Boolean)
      ])
    ];
  }

  async setPlaylistUrl(userId: string, rawUrl: string): Promise<{ success: true }> {
    if (countHttpSchemes(rawUrl) > 1) {
      throw new BadRequestException('Playlist URL must contain only one link.');
    }

    const sanitized = assertSafeHttpUrl(rawUrl).toString();
    await this.ensureLegacySourceMigrated(userId);

    const firstBasePlaylist = await this.prisma.basePlaylist.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true
      }
    });

    if (firstBasePlaylist) {
      await this.prisma.$transaction([
        this.prisma.basePlaylist.update({
          where: { id: firstBasePlaylist.id },
          data: {
            url: sanitized,
            lastError: null
          }
        }),
        this.prisma.basePlaylistCache.deleteMany({
          where: { basePlaylistId: firstBasePlaylist.id }
        })
      ]);
    } else {
      await this.prisma.basePlaylist.create({
        data: {
          userId,
          name: 'Основной плейлист',
          url: sanitized
        }
      });
    }

    await this.prisma.$transaction([
      this.prisma.playlistSource.upsert({
        where: { userId },
        update: {
          url: sanitized,
          lastError: null,
          activeCustomPlaylistId: null
        },
        create: {
          userId,
          url: sanitized
        }
      }),
      this.prisma.playlistCache.deleteMany({
        where: { userId }
      })
    ]);

    return { success: true };
  }

  async listBasePlaylistsForUser(userId: string): Promise<BasePlaylistListItem[]> {
    await this.ensureLegacySourceMigrated(userId);
    const rows = await this.listBasePlaylistsWithCache(userId);
    return rows.map((row) => this.mapBasePlaylistListItem(row));
  }

  async createBasePlaylistForUser(
    userId: string,
    rawName: string,
    rawUrl: string
  ): Promise<BasePlaylistListItem> {
    if (countHttpSchemes(rawUrl) > 1) {
      throw new BadRequestException('Playlist URL must contain only one link.');
    }

    const name = this.normalizeBasePlaylistName(rawName);
    const sanitizedUrl = assertSafeHttpUrl(rawUrl).toString();
    await this.ensureLegacySourceMigrated(userId);
    await this.assertBasePlaylistNameAvailable(userId, name);

    const created = await this.prisma.basePlaylist.create({
      data: {
        userId,
        name,
        url: sanitizedUrl
      },
      select: {
        id: true,
        name: true,
        url: true,
        lastFetchedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        cache: {
          select: {
            channelsJson: true,
            updatedAt: true,
            lastSuccessfulFetchAt: true
          }
        }
      }
    });

    await this.syncLegacySourceUrl(userId);
    return this.mapBasePlaylistListItem(created);
  }

  async updateBasePlaylistForUser(
    userId: string,
    playlistId: string,
    dto: UpdateBasePlaylistDto
  ): Promise<BasePlaylistListItem> {
    const source = await this.getBasePlaylistForUser(userId, playlistId);
    if (!source) {
      throw new NotFoundException('Base playlist not found');
    }

    if (dto.name === undefined && dto.url === undefined) {
      throw new BadRequestException('Nothing to update');
    }

    const nextName =
      dto.name !== undefined ? this.normalizeBasePlaylistName(dto.name) : source.name;
    const nextUrl =
      dto.url !== undefined ? assertSafeHttpUrl(dto.url).toString() : source.url;
    if (dto.url && countHttpSchemes(dto.url) > 1) {
      throw new BadRequestException('Playlist URL must contain only one link.');
    }

    if (nextName !== source.name) {
      await this.assertBasePlaylistNameAvailable(userId, nextName, source.id);
    }

    const urlChanged = nextUrl !== source.url;
    const operations: Array<Prisma.PrismaPromise<unknown>> = [
      this.prisma.basePlaylist.update({
        where: { id: source.id },
        data: {
          name: nextName,
          url: nextUrl,
          lastError: urlChanged ? null : undefined
        }
      })
    ];

    if (urlChanged) {
      operations.push(
        this.prisma.basePlaylistCache.deleteMany({
          where: { basePlaylistId: source.id }
        })
      );
    }

    await this.prisma.$transaction(operations);
    await this.syncLegacySourceUrl(userId);

    const updated = await this.prisma.basePlaylist.findUnique({
      where: { id: source.id },
      select: {
        id: true,
        name: true,
        url: true,
        lastFetchedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        cache: {
          select: {
            channelsJson: true,
            updatedAt: true,
            lastSuccessfulFetchAt: true
          }
        }
      }
    });

    if (!updated) {
      throw new NotFoundException('Base playlist not found');
    }

    return this.mapBasePlaylistListItem(updated);
  }

  async deleteBasePlaylistForUser(userId: string, playlistId: string): Promise<{ success: true }> {
    const source = await this.getBasePlaylistForUser(userId, playlistId);
    if (!source) {
      throw new NotFoundException('Base playlist not found');
    }

    await this.prisma.basePlaylist.delete({
      where: { id: source.id }
    });

    await this.syncLegacySourceUrl(userId);

    const remainingCount = await this.prisma.basePlaylist.count({
      where: { userId }
    });
    if (remainingCount === 0) {
      await this.prisma.playlistSource.updateMany({
        where: { userId },
        data: {
          activeCustomPlaylistId: null
        }
      });
    }

    return { success: true };
  }

  async refreshBasePlaylistForUser(userId: string, playlistId: string): Promise<BasePlaylistListItem> {
    const source = await this.getBasePlaylistForUser(userId, playlistId);
    if (!source) {
      throw new NotFoundException('Base playlist not found');
    }

    await this.refreshBasePlaylistCache(userId, source.id, source.url);
    const refreshed = await this.prisma.basePlaylist.findUnique({
      where: { id: source.id },
      select: {
        id: true,
        name: true,
        url: true,
        lastFetchedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        cache: {
          select: {
            channelsJson: true,
            updatedAt: true,
            lastSuccessfulFetchAt: true
          }
        }
      }
    });

    if (!refreshed) {
      throw new NotFoundException('Base playlist not found');
    }

    return this.mapBasePlaylistListItem(refreshed);
  }

  async getPlaylistStatus(userId: string) {
    await this.ensureLegacySourceMigrated(userId);

    const [sourceSettings, basePlaylists, maybeActiveCustom] = await Promise.all([
      this.prisma.playlistSource.findUnique({
        where: { userId },
        select: {
          url: true,
          activeCustomPlaylistId: true
        }
      }),
      this.listBasePlaylistsWithCache(userId),
      this.prisma.playlistSource
        .findUnique({
          where: { userId },
          select: {
            activeCustomPlaylistId: true
          }
        })
        .then((settings) =>
          settings?.activeCustomPlaylistId
            ? this.prisma.customPlaylist.findFirst({
                where: {
                  id: settings.activeCustomPlaylistId,
                  userId
                },
                select: {
                  id: true,
                  name: true,
                  channelIds: true
                }
              })
            : null
        )
    ]);

    const sourceChannels = await this.getMergedSourceChannelsForUser(userId, false).catch(() => []);
    const latestCacheUpdatedAt =
      basePlaylists
        .map((row) => row.cache?.updatedAt ?? null)
        .filter((value): value is Date => Boolean(value))
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    const firstErrorSource = basePlaylists.find((row) => Boolean(row.lastError));
    const activeChannelIds = this.parseCustomChannelIds(maybeActiveCustom?.channelIds);

    return {
      sourceUrl: basePlaylists[0]?.url ?? sourceSettings?.url ?? null,
      sourceLastError: firstErrorSource
        ? `${firstErrorSource.name}: ${firstErrorSource.lastError}`
        : null,
      cacheUpdatedAt: latestCacheUpdatedAt?.toISOString() ?? null,
      channelsCount: sourceChannels.length,
      basePlaylistsCount: basePlaylists.length,
      activeMode: maybeActiveCustom ? ('custom' as const) : ('source' as const),
      activeCustomPlaylistId: maybeActiveCustom?.id ?? null,
      activeCustomPlaylistName: maybeActiveCustom?.name ?? null,
      activeChannelsCount: maybeActiveCustom ? activeChannelIds.length : sourceChannels.length
    };
  }

  async getSourceChannelsForUser(userId: string): Promise<PlaylistChannelItem[]> {
    return this.getMergedSourceChannelsForUser(userId, true);
  }

  async listCustomPlaylistsForUser(userId: string): Promise<CustomPlaylistListItem[]> {
    const [rows, sourceSettings, basePlaylists] = await Promise.all([
      this.prisma.customPlaylist.findMany({
        where: { userId },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          channelIds: true,
          sourcePlaylistIds: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.playlistSource.findUnique({
        where: { userId },
        select: {
          activeCustomPlaylistId: true
        }
      }),
      this.prisma.basePlaylist.findMany({
        where: { userId },
        select: {
          id: true,
          name: true
        }
      })
    ]);

    const sourceNamesById = new Map(basePlaylists.map((row) => [row.id, row.name] as const));
    return rows.map((row) => {
      const sourcePlaylistIds = this.parseSourcePlaylistIds(row.sourcePlaylistIds);
      const sourcePlaylistNames = sourcePlaylistIds
        .map((sourceId) => sourceNamesById.get(sourceId))
        .filter((name): name is string => Boolean(name));

      return {
        id: row.id,
        name: row.name,
        channelsCount: this.parseCustomChannelIds(row.channelIds).length,
        isActive: sourceSettings?.activeCustomPlaylistId === row.id,
        sourcePlaylistIds,
        sourcePlaylistNames,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString()
      };
    });
  }

  async createCustomPlaylistForUser(userId: string, rawName: string): Promise<CustomPlaylistListItem> {
    const name = this.normalizeCustomPlaylistName(rawName);
    const created = await this.prisma.customPlaylist.create({
      data: {
        userId,
        name,
        channelIds: [],
        sourcePlaylistIds: []
      },
      select: {
        id: true,
        name: true,
        channelIds: true,
        sourcePlaylistIds: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return {
      id: created.id,
      name: created.name,
      channelsCount: 0,
      isActive: false,
      sourcePlaylistIds: [],
      sourcePlaylistNames: [],
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString()
    };
  }

  async renameCustomPlaylistForUser(
    userId: string,
    playlistId: string,
    rawName: string
  ): Promise<CustomPlaylistListItem> {
    const name = this.normalizeCustomPlaylistName(rawName);
    await this.ensureCustomPlaylistOwner(userId, playlistId);

    const [sourceSettings, updated, basePlaylists] = await Promise.all([
      this.prisma.playlistSource.findUnique({
        where: { userId },
        select: {
          activeCustomPlaylistId: true
        }
      }),
      this.prisma.customPlaylist.update({
        where: { id: playlistId },
        data: { name },
        select: {
          id: true,
          name: true,
          channelIds: true,
          sourcePlaylistIds: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.basePlaylist.findMany({
        where: { userId },
        select: {
          id: true,
          name: true
        }
      })
    ]);

    const sourceNamesById = new Map(basePlaylists.map((row) => [row.id, row.name] as const));
    const sourcePlaylistIds = this.parseSourcePlaylistIds(updated.sourcePlaylistIds);
    const sourcePlaylistNames = sourcePlaylistIds
      .map((sourceId) => sourceNamesById.get(sourceId))
      .filter((value): value is string => Boolean(value));

    return {
      id: updated.id,
      name: updated.name,
      channelsCount: this.parseCustomChannelIds(updated.channelIds).length,
      isActive: sourceSettings?.activeCustomPlaylistId === updated.id,
      sourcePlaylistIds,
      sourcePlaylistNames,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString()
    };
  }

  async deleteCustomPlaylistForUser(userId: string, playlistId: string): Promise<{ success: true }> {
    await this.ensureCustomPlaylistOwner(userId, playlistId);

    await this.prisma.$transaction([
      this.prisma.playlistSource.updateMany({
        where: {
          userId,
          activeCustomPlaylistId: playlistId
        },
        data: {
          activeCustomPlaylistId: null
        }
      }),
      this.prisma.customPlaylist.delete({
        where: { id: playlistId }
      })
    ]);

    return { success: true };
  }

  async getCustomPlaylistDetailForUser(userId: string, playlistId: string): Promise<CustomPlaylistDetailItem> {
    const [playlist, sourceChannels, sourceSettings, basePlaylists] = await Promise.all([
      this.prisma.customPlaylist.findFirst({
        where: {
          id: playlistId,
          userId
        },
        select: {
          id: true,
          name: true,
          channelIds: true,
          sourcePlaylistIds: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.getSourceChannelsForUser(userId),
      this.prisma.playlistSource.findUnique({
        where: { userId },
        select: {
          activeCustomPlaylistId: true
        }
      }),
      this.prisma.basePlaylist.findMany({
        where: { userId },
        select: {
          id: true,
          name: true
        }
      })
    ]);

    if (!playlist) {
      throw new NotFoundException('Custom playlist not found');
    }

    const sourceMap = new Map(sourceChannels.map((channel) => [channel.id, channel] as const));
    const orderedIds = this.parseCustomChannelIds(playlist.channelIds);
    const channels = orderedIds
      .map((channelId, index) => {
        const channel = sourceMap.get(channelId);
        if (!channel) {
          return null;
        }

        return {
          ...channel,
          position: index + 1
        };
      })
      .filter((channel): channel is PlaylistChannelItem => Boolean(channel));

    const sourceNamesById = new Map(basePlaylists.map((row) => [row.id, row.name] as const));
    const sourcePlaylistIds = this.parseSourcePlaylistIds(playlist.sourcePlaylistIds);
    const sourcePlaylistNames = sourcePlaylistIds
      .map((sourceId) => sourceNamesById.get(sourceId))
      .filter((value): value is string => Boolean(value));

    return {
      id: playlist.id,
      name: playlist.name,
      channelsCount: channels.length,
      isActive: sourceSettings?.activeCustomPlaylistId === playlist.id,
      sourcePlaylistIds,
      sourcePlaylistNames,
      createdAt: playlist.createdAt.toISOString(),
      updatedAt: playlist.updatedAt.toISOString(),
      channels
    };
  }

  async setCustomPlaylistChannelsForUser(
    userId: string,
    playlistId: string,
    rawChannelIds: string[]
  ): Promise<CustomPlaylistDetailItem> {
    await this.ensureCustomPlaylistOwner(userId, playlistId);
    const sourceChannels = await this.getSourceChannelsForUser(userId);
    const sourceMap = new Map(sourceChannels.map((channel) => [channel.id, channel] as const));
    const sourceIds = new Set(sourceChannels.map((channel) => channel.id));
    const normalizedChannelIds = this
      .normalizeCustomChannelIds(rawChannelIds)
      .filter((channelId) => sourceIds.has(channelId));

    const sourcePlaylistIdsSet = new Set<string>();
    for (const channelId of normalizedChannelIds) {
      const channel = sourceMap.get(channelId);
      if (!channel) {
        continue;
      }

      for (const sourcePlaylistId of channel.sourcePlaylistIds) {
        sourcePlaylistIdsSet.add(sourcePlaylistId);
      }
    }

    const sourcePlaylistIds = [...sourcePlaylistIdsSet];
    await this.prisma.customPlaylist.update({
      where: { id: playlistId },
      data: {
        channelIds: normalizedChannelIds as unknown as Prisma.InputJsonValue,
        sourcePlaylistIds: sourcePlaylistIds as unknown as Prisma.InputJsonValue
      }
    });

    return this.getCustomPlaylistDetailForUser(userId, playlistId);
  }

  async activateCustomPlaylistForUser(userId: string, playlistId: string): Promise<{ success: true }> {
    await this.ensureCustomPlaylistOwner(userId, playlistId);
    await this.ensureLegacySourceMigrated(userId);

    const firstBasePlaylist = await this.prisma.basePlaylist.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { url: true }
    });

    if (!firstBasePlaylist) {
      throw new BadRequestException('Сначала добавьте хотя бы один базовый плейлист.');
    }

    await this.prisma.playlistSource.upsert({
      where: { userId },
      update: {
        activeCustomPlaylistId: playlistId,
        url: firstBasePlaylist.url
      },
      create: {
        userId,
        url: firstBasePlaylist.url,
        activeCustomPlaylistId: playlistId
      }
    });

    return { success: true };
  }

  async activateSourcePlaylistForUser(userId: string): Promise<{ success: true }> {
    await this.ensureLegacySourceMigrated(userId);

    const firstBasePlaylist = await this.prisma.basePlaylist.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { url: true }
    });

    if (!firstBasePlaylist) {
      throw new BadRequestException('Сначала добавьте хотя бы один базовый плейлист.');
    }

    await this.prisma.playlistSource.upsert({
      where: { userId },
      update: {
        activeCustomPlaylistId: null,
        url: firstBasePlaylist.url
      },
      create: {
        userId,
        url: firstBasePlaylist.url,
        activeCustomPlaylistId: null
      }
    });

    return { success: true };
  }

  async getChannelsForDevice(deviceId: string): Promise<Channel[]> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        userId: true,
        playlistMode: true,
        customPlaylistId: true
      }
    });
    if (!device?.userId) {
      throw new NotFoundException('Устройство не привязано');
    }

    const { channels, activeCustomPlaylistId } = await this.getChannelsForUserWithoutCustom(device.userId);
    const mode = (device.playlistMode ?? 'GLOBAL').toUpperCase();

    if (mode === 'SOURCE') {
      return channels;
    }

    if (mode === 'CUSTOM') {
      return this.applyActiveCustomPlaylist(
        device.userId,
        channels,
        device.customPlaylistId ?? null,
        false
      );
    }

    return this.applyActiveCustomPlaylist(device.userId, channels, activeCustomPlaylistId, true);
  }

  async getChannelsForUser(userId: string): Promise<Channel[]> {
    const { channels, activeCustomPlaylistId } = await this.getChannelsForUserWithoutCustom(userId);
    return this.applyActiveCustomPlaylist(userId, channels, activeCustomPlaylistId);
  }

  private async getChannelsForUserWithoutCustom(
    userId: string
  ): Promise<{ channels: Channel[]; activeCustomPlaylistId: string | null }> {
    const sourceSettings = await this.ensurePlaylistSourceSettings(userId);
    const sourceChannels = await this.getMergedSourceChannelsForUser(userId, true);
    const channels = sourceChannels.map((channel) => this.toChannel(channel));
    return {
      channels,
      activeCustomPlaylistId: sourceSettings.activeCustomPlaylistId
    };
  }

  private async applyActiveCustomPlaylist(
    userId: string,
    sourceChannels: Channel[],
    activeCustomPlaylistId: string | null,
    clearMissingSourceSetting = true
  ): Promise<Channel[]> {
    if (!activeCustomPlaylistId) {
      return sourceChannels;
    }

    const customPlaylist = await this.prisma.customPlaylist.findFirst({
      where: {
        id: activeCustomPlaylistId,
        userId
      },
      select: {
        channelIds: true
      }
    });

    if (!customPlaylist) {
      if (!clearMissingSourceSetting) {
        return sourceChannels;
      }
      await this.prisma.playlistSource.updateMany({
        where: {
          userId,
          activeCustomPlaylistId
        },
        data: {
          activeCustomPlaylistId: null
        }
      });
      return sourceChannels;
    }

    const orderedIds = this.parseCustomChannelIds(customPlaylist.channelIds);
    if (orderedIds.length === 0) {
      return [];
    }

    const sourceMap = new Map(sourceChannels.map((channel: Channel) => [channel.id, channel] as const));
    return orderedIds
      .map((channelId: string) => sourceMap.get(channelId))
      .filter((channel): channel is Channel => Boolean(channel));
  }

  private async getMergedSourceChannelsForUser(
    userId: string,
    allowRefresh: boolean
  ): Promise<PlaylistChannelItem[]> {
    await this.ensureLegacySourceMigrated(userId);

    const basePlaylists = await this.prisma.basePlaylist.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        url: true
      }
    });

    if (!basePlaylists.length) {
      throw new NotFoundException('Source playlist URL is not configured');
    }

    const channelsBySource = await Promise.all(
      basePlaylists.map(async (source) => ({
        source,
        channels: await this.getChannelsForBasePlaylist(userId, source, allowRefresh)
      }))
    );

    const merged = new Map<string, PlaylistChannelItem>();
    for (const sourceChannels of channelsBySource) {
      for (const channel of sourceChannels.channels) {
        const existing = merged.get(channel.id);
        if (existing) {
          if (!existing.sourcePlaylistIds.includes(sourceChannels.source.id)) {
            existing.sourcePlaylistIds.push(sourceChannels.source.id);
            existing.sourcePlaylistNames.push(sourceChannels.source.name);
          }
          continue;
        }

        merged.set(channel.id, {
          ...channel,
          position: 0,
          sourcePlaylistIds: [sourceChannels.source.id],
          sourcePlaylistNames: [sourceChannels.source.name]
        });
      }
    }

    return Array.from(merged.values()).map((channel, index) => ({
      ...channel,
      position: index + 1
    }));
  }

  private async getChannelsForBasePlaylist(
    userId: string,
    source: BasePlaylistIdentityRow,
    allowRefresh: boolean
  ): Promise<Channel[]> {
    const cache = await this.prisma.basePlaylistCache.findUnique({
      where: {
        basePlaylistId: source.id
      }
    });
    const cacheAgeMs = cache
      ? Date.now() - new Date(cache.updatedAt).getTime()
      : Number.POSITIVE_INFINITY;

    if (cache && cacheAgeMs < this.cacheTtlMs) {
      return parseChannelsJson(cache.channelsJson);
    }

    if (!allowRefresh) {
      return cache ? parseChannelsJson(cache.channelsJson) : [];
    }

    try {
      return await this.refreshBasePlaylistCache(userId, source.id, source.url);
    } catch (error) {
      if (cache) {
        return parseChannelsJson(cache.channelsJson);
      }
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to load playlist');
    }
  }

  private async refreshBasePlaylistCache(
    userId: string,
    basePlaylistId: string,
    sourceUrl: string
  ): Promise<Channel[]> {
    assertSafeHttpUrl(sourceUrl);

    const content = await fetchTextWithRetry(sourceUrl, {
      timeoutMs: 10000,
      retries: 2,
      backoffMs: 750
    });

    const channels = parseM3u(content);
    if (!channels.length) {
      await this.prisma.basePlaylist.update({
        where: { id: basePlaylistId },
        data: {
          lastError: 'Playlist parsed but contains no channels'
        }
      });
      throw new BadRequestException('Invalid or empty playlist');
    }

    const enrichedChannels = await this.enrichChannelsFromOttCatalog(userId, channels);

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.basePlaylist.update({
        where: { id: basePlaylistId },
        data: {
          lastError: null,
          lastFetchedAt: now
        }
      }),
      this.prisma.basePlaylistCache.upsert({
        where: { basePlaylistId },
        update: {
          channelsJson: enrichedChannels as unknown as Prisma.InputJsonValue,
          lastSuccessfulFetchAt: now
        },
        create: {
          basePlaylistId,
          channelsJson: enrichedChannels as unknown as Prisma.InputJsonValue,
          lastSuccessfulFetchAt: now
        }
      })
    ]);

    return enrichedChannels;
  }

  private async enrichChannelsFromOttCatalog(userId: string, channels: Channel[]): Promise<Channel[]> {
    if (!channels.some((channel) => !channel.tvgId || !channel.logo)) {
      return channels;
    }

    const cachedEnriched = await this.enrichChannelsWithCachedOttChannels(userId, channels);
    let bestChannels = cachedEnriched.channels;
    let bestMatchedChannels = cachedEnriched.matchedChannels;

    const providers = await this.getCandidateProviders(userId);
    if (!providers.length) {
      return bestChannels;
    }

    for (const provider of providers) {
      const enriched = await this.enrichChannelsWithProvider(userId, provider.id, bestChannels);
      if (enriched.matchedChannels <= bestMatchedChannels) {
        continue;
      }

      bestChannels = enriched.channels;
      bestMatchedChannels = enriched.matchedChannels;
    }

    return bestChannels;
  }

  private async enrichChannelsWithProvider(
    userId: string,
    providerId: string,
    channels: Channel[]
  ): Promise<{ channels: Channel[]; matchedChannels: number }> {
    try {
      await this.ottCatalogService.syncProviderChannels(userId, providerId, false);
    } catch {
      // Continue with already cached channels if remote is not reachable.
    }

    const ottChannels = await this.prisma.ottChannel.findMany({
      where: {
        userId,
        providerId,
        OR: [{ tvgId: { not: null } }, { logoUrl: { not: null } }]
      },
      select: {
        displayName: true,
        tvgId: true,
        logoUrl: true
      }
    });

    return this.applyOttChannelCandidates(channels, ottChannels);
  }

  private async enrichChannelsWithCachedOttChannels(
    userId: string,
    channels: Channel[]
  ): Promise<{ channels: Channel[]; matchedChannels: number }> {
    const ottChannels = await this.prisma.ottChannel.findMany({
      where: {
        userId,
        OR: [{ tvgId: { not: null } }, { logoUrl: { not: null } }]
      },
      select: {
        displayName: true,
        tvgId: true,
        logoUrl: true
      }
    });

    return this.applyOttChannelCandidates(channels, ottChannels);
  }

  private applyOttChannelCandidates(
    channels: Channel[],
    ottChannels: OttChannelLookupRow[]
  ): { channels: Channel[]; matchedChannels: number } {
    if (!ottChannels.length) {
      return {
        channels,
        matchedChannels: this.countChannelsWithMetadata(channels)
      };
    }

    const exactLookup = new Map<string, OttChannelCandidate[]>();
    const relaxedLookup = new Map<string, OttChannelCandidate[]>();
    const tvgLookup = new Map<string, OttChannelCandidate[]>();
    for (const ottChannel of ottChannels) {
      const candidate: OttChannelCandidate = {
        tvgId: ottChannel.tvgId ?? undefined,
        logo: ottChannel.logoUrl ?? undefined
      };

      pushLookupCandidate(exactLookup, normalizeChannelName(ottChannel.displayName), candidate);
      pushLookupCandidate(
        relaxedLookup,
        normalizeChannelNameNoQuality(ottChannel.displayName),
        candidate
      );
      pushLookupCandidate(tvgLookup, normalizeTvgId(ottChannel.tvgId), candidate);
    }

    let hasChanges = false;
    const enriched = channels.map((channel) => {
      if (channel.tvgId && channel.logo) {
        return channel;
      }

      const tvgCandidate = this.pickBestCandidate(tvgLookup.get(normalizeTvgId(channel.tvgId)));
      const exactCandidate = this.pickBestCandidate(exactLookup.get(normalizeChannelName(channel.name)));
      const fallbackCandidate =
        tvgCandidate ??
        exactCandidate ??
        this.pickBestCandidate(relaxedLookup.get(normalizeChannelNameNoQuality(channel.name)));
      if (!fallbackCandidate) {
        return channel;
      }

      const nextTvgId = channel.tvgId ?? fallbackCandidate.tvgId;
      const nextLogo = channel.logo ?? fallbackCandidate.logo;
      if (nextTvgId === channel.tvgId && nextLogo === channel.logo) {
        return channel;
      }

      hasChanges = true;
      return {
        ...channel,
        id: buildChannelId(nextTvgId, channel.name, channel.url),
        tvgId: nextTvgId,
        logo: nextLogo
      };
    });

    const resultChannels = hasChanges ? enriched : channels;
    return {
      channels: resultChannels,
      matchedChannels: this.countChannelsWithMetadata(resultChannels)
    };
  }

  private normalizeBasePlaylistName(rawName: string): string {
    const name = rawName.trim();
    if (!name) {
      throw new BadRequestException('Playlist name is required');
    }
    if (name.length > 120) {
      throw new BadRequestException('Playlist name must be 120 characters or less');
    }
    return name;
  }

  private normalizeCustomPlaylistName(rawName: string): string {
    const name = rawName.trim();
    if (!name) {
      throw new BadRequestException('Playlist name is required');
    }
    if (name.length > 120) {
      throw new BadRequestException('Playlist name must be 120 characters or less');
    }
    return name;
  }

  private normalizeCustomChannelIds(rawChannelIds: string[]): string[] {
    return this.parseCustomChannelIds(rawChannelIds);
  }

  private parseCustomChannelIds(rawValue: unknown): string[] {
    if (!Array.isArray(rawValue)) {
      return [];
    }

    const unique = new Set<string>();
    const normalized: string[] = [];
    for (const value of rawValue) {
      if (typeof value !== 'string') {
        continue;
      }

      const channelId = value.trim();
      if (!channelId || unique.has(channelId)) {
        continue;
      }

      unique.add(channelId);
      normalized.push(channelId);
    }

    return normalized;
  }

  private parseSourcePlaylistIds(rawValue: unknown): string[] {
    if (!Array.isArray(rawValue)) {
      return [];
    }

    const unique = new Set<string>();
    const normalized: string[] = [];
    for (const value of rawValue) {
      if (typeof value !== 'string') {
        continue;
      }

      const sourcePlaylistId = value.trim();
      if (!sourcePlaylistId || unique.has(sourcePlaylistId)) {
        continue;
      }

      unique.add(sourcePlaylistId);
      normalized.push(sourcePlaylistId);
    }

    return normalized;
  }

  private async ensureCustomPlaylistOwner(userId: string, playlistId: string): Promise<void> {
    const playlist = await this.prisma.customPlaylist.findFirst({
      where: {
        id: playlistId,
        userId
      },
      select: {
        id: true
      }
    });

    if (!playlist) {
      throw new NotFoundException('Custom playlist not found');
    }
  }

  private async assertBasePlaylistNameAvailable(
    userId: string,
    name: string,
    exceptPlaylistId?: string
  ): Promise<void> {
    const conflicting = await this.prisma.basePlaylist.findFirst({
      where: {
        userId,
        name,
        ...(exceptPlaylistId
          ? {
              id: {
                not: exceptPlaylistId
              }
            }
          : {})
      },
      select: {
        id: true
      }
    });

    if (conflicting) {
      throw new BadRequestException('A base playlist with this name already exists');
    }
  }

  private async getBasePlaylistForUser(
    userId: string,
    playlistId: string
  ): Promise<BasePlaylistIdentityRow | null> {
    return this.prisma.basePlaylist.findFirst({
      where: {
        id: playlistId,
        userId
      },
      select: {
        id: true,
        name: true,
        url: true
      }
    });
  }

  private mapBasePlaylistListItem(row: BasePlaylistWithCacheRow): BasePlaylistListItem {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      channelsCount: parseChannelsJson(row.cache?.channelsJson).length,
      cacheUpdatedAt: row.cache?.updatedAt?.toISOString() ?? null,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  private async listBasePlaylistsWithCache(userId: string): Promise<BasePlaylistWithCacheRow[]> {
    return this.prisma.basePlaylist.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        url: true,
        lastFetchedAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        cache: {
          select: {
            channelsJson: true,
            updatedAt: true,
            lastSuccessfulFetchAt: true
          }
        }
      }
    });
  }

  private toChannel(item: PlaylistChannelItem): Channel {
    const { position, sourcePlaylistIds, sourcePlaylistNames, ...channel } = item;
    void position;
    void sourcePlaylistIds;
    void sourcePlaylistNames;
    return channel;
  }

  private countChannelsWithMetadata(channels: Channel[]): number {
    return channels.filter((channel) => Boolean(channel.tvgId || channel.logo)).length;
  }

  private async getCandidateProviders(userId: string): Promise<Array<{ id: string; key: string }>> {
    let providers = await this.prisma.ottProvider.findMany({
      where: {
        userId,
        key: {
          in: this.ottCandidateProviderKeys
        }
      },
      select: {
        id: true,
        key: true
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
            in: this.ottCandidateProviderKeys
          }
        },
        select: {
          id: true,
          key: true
        }
      });
    }

    const providersByKey = new Map(
      providers.map((provider) => [provider.key.trim().toLowerCase(), provider] as const)
    );

    const preferredProviders = this.ottCandidateProviderKeys
      .map((key) => providersByKey.get(key))
      .filter((provider): provider is { id: string; key: string } => Boolean(provider));

    const preferredKeys = new Set(preferredProviders.map((provider) => provider.key.trim().toLowerCase()));
    const fallbackProviders = await this.prisma.ottProvider.findMany({
      where: {
        userId,
        key: {
          notIn: [...preferredKeys]
        }
      },
      orderBy: [{ channelsCount: 'desc' }, { updatedAt: 'desc' }],
      take: 2,
      select: {
        id: true,
        key: true
      }
    });

    return [...preferredProviders, ...fallbackProviders];
  }

  private pickBestCandidate(candidates: OttChannelCandidate[] | undefined): OttChannelCandidate | null {
    if (!candidates || candidates.length === 0) {
      return null;
    }

    const sorted = [...candidates].sort(
      (left, right) => this.scoreCandidate(right) - this.scoreCandidate(left)
    );
    const bestScore = this.scoreCandidate(sorted[0]);
    const bestCandidates = sorted.filter((candidate) => this.scoreCandidate(candidate) === bestScore);
    if (bestCandidates.length === 1) {
      return bestCandidates[0];
    }

    const reference = bestCandidates[0];
    const isSameMetadata = bestCandidates.every(
      (candidate) =>
        (candidate.tvgId ?? '') === (reference.tvgId ?? '') &&
        (candidate.logo ?? '') === (reference.logo ?? '')
    );
    return isSameMetadata ? reference : null;
  }

  private scoreCandidate(candidate: OttChannelCandidate): number {
    let score = 0;
    if (candidate.tvgId) {
      score += 2;
    }
    if (candidate.logo) {
      score += 1;
    }
    return score;
  }

  private async ensureLegacySourceMigrated(userId: string): Promise<void> {
    const existingBaseCount = await this.prisma.basePlaylist.count({
      where: { userId }
    });
    if (existingBaseCount > 0) {
      return;
    }

    const legacySource = await this.prisma.playlistSource.findUnique({
      where: { userId },
      select: {
        url: true,
        lastFetchedAt: true,
        lastError: true
      }
    });
    if (!legacySource?.url || legacySource.url === LEGACY_SOURCE_PLACEHOLDER_URL) {
      return;
    }

    const legacyCache = await this.prisma.playlistCache.findUnique({
      where: { userId },
      select: {
        channelsJson: true,
        lastSuccessfulFetchAt: true
      }
    });

    const createdBase = await this.prisma.basePlaylist.create({
      data: {
        userId,
        name: 'Основной плейлист',
        url: legacySource.url,
        lastFetchedAt: legacySource.lastFetchedAt,
        lastError: legacySource.lastError
      },
      select: {
        id: true
      }
    });

    if (legacyCache) {
      await this.prisma.basePlaylistCache.create({
        data: {
          basePlaylistId: createdBase.id,
          channelsJson: legacyCache.channelsJson as Prisma.InputJsonValue,
          lastSuccessfulFetchAt: legacyCache.lastSuccessfulFetchAt
        }
      });
    }
  }

  private async ensurePlaylistSourceSettings(
    userId: string
  ): Promise<{ activeCustomPlaylistId: string | null }> {
    await this.ensureLegacySourceMigrated(userId);

    const existing = await this.prisma.playlistSource.findUnique({
      where: { userId },
      select: {
        activeCustomPlaylistId: true
      }
    });
    if (existing) {
      return existing;
    }

    const firstBasePlaylist = await this.prisma.basePlaylist.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        url: true
      }
    });

    const created = await this.prisma.playlistSource.create({
      data: {
        userId,
        url: firstBasePlaylist?.url ?? LEGACY_SOURCE_PLACEHOLDER_URL
      },
      select: {
        activeCustomPlaylistId: true
      }
    });

    return created;
  }

  private async syncLegacySourceUrl(userId: string): Promise<void> {
    const firstBasePlaylist = await this.prisma.basePlaylist.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        url: true
      }
    });

    const nextUrl = firstBasePlaylist?.url ?? LEGACY_SOURCE_PLACEHOLDER_URL;
    await this.prisma.playlistSource.upsert({
      where: { userId },
      update: {
        url: nextUrl
      },
      create: {
        userId,
        url: nextUrl
      }
    });
  }
}
