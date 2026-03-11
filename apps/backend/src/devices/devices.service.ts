import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PairingStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { PairStartDto } from './dto/pair-start.dto';
import { extractDeviceIpTag, withDeviceIpTag } from '../common/client-ip.util';

const PLAYLIST_MODES = ['GLOBAL', 'SOURCE', 'CUSTOM'] as const;
type DevicePlaylistMode = (typeof PLAYLIST_MODES)[number];

interface DevicePlaylistAssignment {
  playlistMode: DevicePlaylistMode;
  customPlaylistId: string | null;
}

interface DeviceIdentity {
  normalizedName: string;
  fingerprint?: string;
}

export interface PairingStartResponse {
  code: string;
  expiresAt: string;
  pollIntervalSec: number;
}

export interface PairedDeviceListItem {
  id: string;
  name: string;
  platform: string;
  macAddress: string | null;
  fingerprint: string | null;
  ipAddress: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  clientId: string | null;
  clientName: string | null;
  playlistMode: DevicePlaylistMode;
  customPlaylistId: string | null;
  customPlaylistName: string | null;
  sourcePlaylistId: string | null;
  sourcePlaylistName: string | null;
}

export interface WebOsRestoreResponse {
  restored: boolean;
  deviceToken?: string;
  deviceName?: string;
}

export interface DeviceRestoreResponse {
  restored: boolean;
  deviceToken?: string;
  deviceName?: string;
}

@Injectable()
export class DevicesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  async startPairing(dto: PairStartDto, clientIp?: string): Promise<PairingStartResponse> {
    await this.cleanupStalePairingArtifacts();

    const code = await this.generateUniqueCode();
    const ttlSec = Number(this.configService.get('PAIRING_CODE_TTL_SEC') ?? 600);
    const pollIntervalSec = Number(this.configService.get('PAIRING_POLL_INTERVAL_SEC') ?? 3);
    const expiresAt = new Date(Date.now() + ttlSec * 1000);
    const sanitizedDeviceName = this.stripDeviceIpTag(dto.deviceName);
    const storedDeviceName = withDeviceIpTag(sanitizedDeviceName, clientIp);
    const identity = this.resolveDeviceIdentity(sanitizedDeviceName);

    const candidateUnpairedDevices = await this.prisma.device.findMany({
      where: {
        platform: dto.platform,
        userId: null,
        pairedAt: null
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true
      },
      take: 50
    });

    const reusableDevice = candidateUnpairedDevices.find((row) =>
      this.matchesDeviceIdentity(this.resolveDeviceIdentity(row.name), identity)
    );

    const device = reusableDevice
      ? await this.prisma.device.update({
          where: { id: reusableDevice.id },
          data: {
            name: storedDeviceName
          }
        })
      : await this.prisma.device.create({
          data: {
            name: storedDeviceName,
            platform: dto.platform
          }
        });

    await this.prisma.$transaction([
      this.prisma.pairingSession.deleteMany({
        where: {
          deviceId: device.id,
          status: {
            in: [PairingStatus.PENDING, PairingStatus.EXPIRED]
          }
        }
      }),
      this.prisma.pairingSession.create({
        data: {
          code,
          deviceId: device.id,
          expiresAt,
          pollIntervalSec,
          status: PairingStatus.PENDING
        }
      })
    ]);

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      pollIntervalSec
    };
  }

  async confirmPairing(
    code: string,
    userId: string,
    clientId?: string,
    playlistMode?: string,
    customPlaylistId?: string
  ): Promise<{ success: true }> {
    const pairing = await this.prisma.pairingSession.findUnique({
      where: { code },
      include: { device: true }
    });

    if (!pairing) {
      throw new NotFoundException('Pairing code not found');
    }

    if (pairing.expiresAt.getTime() < Date.now()) {
      await this.prisma.pairingSession.update({
        where: { id: pairing.id },
        data: { status: PairingStatus.EXPIRED }
      });
      throw new ConflictException('Pairing code is expired');
    }

    if (pairing.status === PairingStatus.PAIRED) {
      throw new ConflictException('Pairing code is already used');
    }

    const normalizedClientId = clientId?.trim();
    const incomingIdentity = this.resolveDeviceIdentity(pairing.device.name);
    let pairedClientId: string | null = null;
    let canReuseExistingForClient = false;

    if (normalizedClientId) {
      const client = await this.prisma.client.findFirst({
        where: {
          id: normalizedClientId,
          userId
        },
        include: {
          devices: {
            where: {
              userId,
              pairedAt: {
                not: null
              }
            },
            select: {
              id: true
            }
          }
        }
      });

      if (!client) {
        throw new NotFoundException('Client not found');
      }

      pairedClientId = client.id;

      const existingForSameClient = await this.findExistingPairedDeviceByIdentity(
        userId,
        pairing.device.platform,
        pairedClientId,
        incomingIdentity,
        pairing.deviceId
      );
      canReuseExistingForClient = Boolean(existingForSameClient);

      if (client.devices.length >= client.devicesAllowed && !canReuseExistingForClient) {
        throw new ConflictException(
          `Client reached devices limit (${client.devicesAllowed}). Increase limit in admin.`
        );
      }
    }

    const assignment = await this.resolveDevicePlaylistAssignment(
      userId,
      playlistMode,
      customPlaylistId
    );
    const existingDevice = await this.findExistingPairedDeviceByIdentity(
      userId,
      pairing.device.platform,
      pairedClientId,
      incomingIdentity,
      pairing.deviceId
    );
    const resolvedDeviceToken =
      existingDevice?.deviceToken?.trim() ||
      pairing.device.deviceToken?.trim() ||
      randomBytes(32).toString('base64url');
    const persistedDeviceName = withDeviceIpTag(
      this.stripDeviceIpTag(pairing.device.name),
      extractDeviceIpTag(pairing.device.name)
    );
    const now = new Date();
    const targetDeviceId = existingDevice?.id ?? pairing.deviceId;

    if (existingDevice) {
      await this.prisma.$transaction([
        this.prisma.device.update({
          where: { id: existingDevice.id },
          data: {
            name: persistedDeviceName,
            userId,
            pairedAt: now,
            deviceToken: resolvedDeviceToken,
            clientId: pairedClientId,
            playlistMode: assignment.playlistMode,
            customPlaylistId: assignment.customPlaylistId
          }
        }),
        this.prisma.pairingSession.update({
          where: { id: pairing.id },
          data: {
            status: PairingStatus.PAIRED,
            userId,
            confirmedAt: now,
            deviceId: existingDevice.id
          }
        }),
        this.prisma.pairingSession.deleteMany({
          where: {
            deviceId: pairing.deviceId,
            id: {
              not: pairing.id
            }
          }
        }),
        this.prisma.device.delete({
          where: { id: pairing.deviceId }
        })
      ]);
    } else {
      await this.prisma.$transaction([
        this.prisma.device.update({
          where: { id: pairing.deviceId },
          data: {
            name: persistedDeviceName,
            userId,
            pairedAt: now,
            deviceToken: resolvedDeviceToken,
            clientId: pairedClientId,
            playlistMode: assignment.playlistMode,
            customPlaylistId: assignment.customPlaylistId
          }
        }),
        this.prisma.pairingSession.update({
          where: { id: pairing.id },
          data: {
            status: PairingStatus.PAIRED,
            userId,
            confirmedAt: now
          }
        })
      ]);
    }

    // Keep only the latest pairing record for a physical device identity.
    await this.prisma.pairingSession.deleteMany({
      where: {
        deviceId: targetDeviceId,
        id: {
          not: pairing.id
        }
      }
    });

    return { success: true };
  }

  async getPairingStatus(code: string): Promise<{
    status: PairingStatus;
    deviceToken?: string;
    expiresAt: string;
    pollIntervalSec: number;
  }> {
    const pairing = await this.prisma.pairingSession.findUnique({
      where: { code },
      include: { device: true }
    });

    if (!pairing) {
      throw new NotFoundException('Pairing code not found');
    }

    if (pairing.expiresAt.getTime() < Date.now() && pairing.status === PairingStatus.PENDING) {
      await this.prisma.pairingSession.update({
        where: { id: pairing.id },
        data: { status: PairingStatus.EXPIRED }
      });

      return {
        status: PairingStatus.EXPIRED,
        expiresAt: pairing.expiresAt.toISOString(),
        pollIntervalSec: pairing.pollIntervalSec
      };
    }

    return {
      status: pairing.status,
      deviceToken:
        pairing.status === PairingStatus.PAIRED
          ? (pairing.device.deviceToken ?? undefined)
          : undefined,
      expiresAt: pairing.expiresAt.toISOString(),
      pollIntervalSec: pairing.pollIntervalSec
    };
  }

  async listPairedDevicesForUser(userId: string): Promise<PairedDeviceListItem[]> {
    const [devices, customPlaylists, basePlaylists] = await Promise.all([
      this.prisma.device.findMany({
        where: {
          userId,
          pairedAt: {
            not: null
          }
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          name: true,
          platform: true,
          pairedAt: true,
          lastSeenAt: true,
          playlistMode: true,
          customPlaylistId: true,
          client: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              sourcePlaylistIds: true
            }
          }
        }
      }),
      this.prisma.customPlaylist.findMany({
        where: { userId },
        select: {
          id: true,
          name: true
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

    const customNameById = new Map(customPlaylists.map((row) => [row.id, row.name] as const));
    const sourceNameById = new Map(basePlaylists.map((row) => [row.id, row.name] as const));
    return devices.map((device) => {
      const mode = this.normalizeDevicePlaylistMode(device.playlistMode);
      const customId = mode === 'CUSTOM' ? device.customPlaylistId : null;
      const customName = customId ? (customNameById.get(customId) ?? null) : null;
      const sourceId = mode === 'SOURCE' ? device.customPlaylistId : null;
      const clientSourcePlaylistIds = this.asStringArray(device.client?.sourcePlaylistIds);
      const sourceName =
        sourceId
          ? (sourceNameById.get(sourceId) ?? null)
          : mode === 'SOURCE' && clientSourcePlaylistIds.length > 0
            ? `Subscriber sources (${clientSourcePlaylistIds.length})`
            : null;
      const clientName = device.client
        ? `${device.client.lastName} ${device.client.firstName}`.trim()
        : null;
      const macAddress = this.extractDisplayMacFromName(device.name);
      const fingerprint = macAddress ? null : this.extractDisplayFingerprintFromName(device.name);

      return {
        id: device.id,
        name: this.stripDeviceIpTag(device.name),
        platform: device.platform,
        macAddress,
        fingerprint,
        ipAddress: extractDeviceIpTag(device.name),
        pairedAt: device.pairedAt?.toISOString() ?? null,
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        clientId: device.client?.id ?? null,
        clientName,
        playlistMode: mode,
        customPlaylistId: customId,
        customPlaylistName: customName,
        sourcePlaylistId: sourceId,
        sourcePlaylistName: sourceName
      };
    });
  }

  async restoreWebOsTokenByMac(macAddress?: string): Promise<WebOsRestoreResponse> {
    const normalizedMac = this.normalizeMacAddress(macAddress);
    const devices = await this.prisma.device.findMany({
      where: {
        platform: 'webos',
        userId: {
          not: null
        },
        pairedAt: {
          not: null
        },
        deviceToken: {
          not: null
        }
      },
      orderBy: [{ pairedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        name: true,
        deviceToken: true
      },
      take: 500
    });

    if (normalizedMac.length === 12) {
      const matchedByMac = devices.find((device) => {
        const nameMac = this.extractNormalizedMacFromName(device.name);
        return Boolean(nameMac) && nameMac === normalizedMac;
      });
      const macToken = matchedByMac?.deviceToken?.trim();
      if (macToken) {
        return {
          restored: true,
          deviceToken: macToken,
          deviceName: matchedByMac ? this.stripDeviceIpTag(matchedByMac.name) : undefined
        };
      }
    }

    // Legacy fallback for older devices paired without MAC in name.
    if (devices.length === 1) {
      const only = devices[0];
      const token = only.deviceToken?.trim();
      if (token) {
        return {
          restored: true,
          deviceToken: token,
          deviceName: this.stripDeviceIpTag(only.name)
        };
      }
    }

    return {
      restored: false
    };
  }

  async restoreTokenByFingerprint(
    platform?: string,
    fingerprint?: string,
    deviceName?: string
  ): Promise<DeviceRestoreResponse> {
    const normalizedPlatform = this.normalizePlatform(platform);
    if (!normalizedPlatform) {
      return {
        restored: false
      };
    }

    const normalizedFingerprint = this.normalizeFingerprint(fingerprint);
    const normalizedDeviceName = this.normalizeDeviceName(deviceName);
    const devices = await this.prisma.device.findMany({
      where: {
        platform: normalizedPlatform,
        userId: {
          not: null
        },
        pairedAt: {
          not: null
        },
        deviceToken: {
          not: null
        }
      },
      orderBy: [{ pairedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        name: true,
        deviceToken: true
      },
      take: 500
    });

    if (normalizedFingerprint) {
      const matchedByFingerprint = devices.find((device) => {
        const extracted = this.extractNormalizedFingerprintFromName(device.name);
        return Boolean(extracted) && extracted === normalizedFingerprint;
      });
      const token = matchedByFingerprint?.deviceToken?.trim();
      if (token) {
        return {
          restored: true,
          deviceToken: token,
          deviceName: matchedByFingerprint
            ? this.stripDeviceIpTag(matchedByFingerprint.name)
            : undefined
        };
      }
    }

    if (normalizedDeviceName) {
      const matchedByName = devices.find(
        (device) => this.normalizeDeviceName(device.name) === normalizedDeviceName
      );
      const token = matchedByName?.deviceToken?.trim();
      if (token) {
        return {
          restored: true,
          deviceToken: token,
          deviceName: matchedByName ? this.stripDeviceIpTag(matchedByName.name) : undefined
        };
      }
    }

    // Legacy fallback for older clients that did not send fingerprint in device name.
    if (devices.length === 1) {
      const only = devices[0];
      const token = only.deviceToken?.trim();
      if (token) {
        return {
          restored: true,
          deviceToken: token,
          deviceName: this.stripDeviceIpTag(only.name)
        };
      }
    }

    return {
      restored: false
    };
  }

  async updateDevicePlaylistForUser(
    userId: string,
    deviceId: string,
    playlistMode?: string,
    customPlaylistId?: string
  ): Promise<PairedDeviceListItem> {
    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        userId,
        pairedAt: {
          not: null
        }
      },
      select: {
        id: true,
        playlistMode: true,
        customPlaylistId: true
      }
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const effectiveMode = playlistMode ?? this.normalizeDevicePlaylistMode(device.playlistMode);
    const effectiveCustomPlaylistId =
      customPlaylistId !== undefined ? customPlaylistId : (device.customPlaylistId ?? undefined);

    const assignment = await this.resolveDevicePlaylistAssignment(
      userId,
      effectiveMode,
      effectiveCustomPlaylistId
    );

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        playlistMode: assignment.playlistMode,
        customPlaylistId: assignment.customPlaylistId
      }
    });

    const rows = await this.listPairedDevicesForUser(userId);
    const updated = rows.find((row) => row.id === device.id);
    if (!updated) {
      throw new NotFoundException('Device not found');
    }

    return updated;
  }

  async getDeviceById(id: string) {
    return this.prisma.device.findUnique({ where: { id } });
  }

  private async resolveDevicePlaylistAssignment(
    userId: string,
    playlistMode?: string,
    customPlaylistId?: string
  ): Promise<DevicePlaylistAssignment> {
    const mode = this.normalizeDevicePlaylistMode(playlistMode);

    if (mode === 'GLOBAL') {
      return {
        playlistMode: 'GLOBAL',
        customPlaylistId: null
      };
    }

    if (mode === 'SOURCE') {
      const sourceId = customPlaylistId?.trim();
      if (!sourceId) {
        return {
          playlistMode: 'SOURCE',
          customPlaylistId: null
        };
      }

      const exists = await this.prisma.basePlaylist.findFirst({
        where: {
          id: sourceId,
          userId
        },
        select: {
          id: true
        }
      });
      if (!exists) {
        throw new NotFoundException('Source playlist not found');
      }

      return {
        playlistMode: 'SOURCE',
        customPlaylistId: sourceId
      };
    }

    const customId = customPlaylistId?.trim();
    if (!customId) {
      throw new BadRequestException('customPlaylistId is required when playlistMode=CUSTOM');
    }

    const exists = await this.prisma.customPlaylist.findFirst({
      where: {
        id: customId,
        userId
      },
      select: {
        id: true
      }
    });

    if (!exists) {
      throw new NotFoundException('Custom playlist not found');
    }

    return {
      playlistMode: 'CUSTOM',
      customPlaylistId: customId
    };
  }

  private normalizeDevicePlaylistMode(rawMode?: string): DevicePlaylistMode {
    const normalized = (rawMode ?? 'GLOBAL').toUpperCase();
    if (normalized === 'SOURCE') {
      return 'SOURCE';
    }
    if (normalized === 'CUSTOM') {
      return 'CUSTOM';
    }
    return 'GLOBAL';
  }

  private normalizeMacAddress(rawValue?: string): string {
    return (rawValue ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-F]/g, '');
  }

  private normalizePlatform(rawValue?: string): string {
    const normalized = (rawValue ?? '').trim().toLowerCase();
    return normalized || '';
  }

  private normalizeFingerprint(rawValue?: string): string {
    const normalized = (rawValue ?? '')
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '');
    return normalized.length >= 6 ? normalized : '';
  }

  private normalizeDeviceName(rawValue?: string): string {
    return this.stripDeviceIpTag(rawValue ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private extractNormalizedFingerprintFromName(deviceName?: string): string | undefined {
    if (!deviceName) {
      return undefined;
    }

    const inSquareBrackets = deviceName.match(/\[([^\]]+)\]/)?.[1];
    if (inSquareBrackets && /^ip\s*:/i.test(inSquareBrackets.trim())) {
      return this.extractNormalizedMacFromName(deviceName);
    }
    const fromBrackets = this.normalizeFingerprint(inSquareBrackets);
    if (fromBrackets) {
      return fromBrackets;
    }

    return this.extractNormalizedMacFromName(deviceName);
  }

  private extractNormalizedMacFromName(deviceName?: string): string | undefined {
    if (!deviceName) {
      return undefined;
    }

    const regex =
      /([0-9A-F]{2}(?::[0-9A-F]{2}){5}|[0-9A-F]{2}(?:-[0-9A-F]{2}){5}|[0-9A-F]{4}(?:\.[0-9A-F]{4}){2}|[0-9A-F]{12})/i;
    const matched = deviceName.match(regex)?.[0];
    const normalized = this.normalizeMacAddress(matched);
    return normalized.length === 12 ? normalized : undefined;
  }

  private stripDeviceIpTag(deviceName: string): string {
    return deviceName.replace(/\s*\[IP:\s*[^\]]+\]\s*$/i, '').trim();
  }

  private extractDisplayMacFromName(deviceName: string): string | null {
    const normalizedMac = this.extractNormalizedMacFromName(deviceName);
    if (!normalizedMac) {
      return null;
    }

    return normalizedMac.match(/.{1,2}/g)?.join(':') ?? null;
  }

  private extractDisplayFingerprintFromName(deviceName: string): string | null {
    const inSquareBrackets = deviceName.match(/\[([^\]]+)\]/)?.[1];
    if (!inSquareBrackets || /^ip\s*:/i.test(inSquareBrackets.trim())) {
      return null;
    }

    const normalized = this.normalizeFingerprint(inSquareBrackets);
    return normalized || null;
  }

  private resolveDeviceIdentity(deviceName?: string): DeviceIdentity {
    const sanitizedName = this.stripDeviceIpTag(deviceName ?? '');
    return {
      normalizedName: this.normalizeDeviceName(sanitizedName),
      fingerprint: this.extractNormalizedFingerprintFromName(sanitizedName)
    };
  }

  private matchesDeviceIdentity(left: DeviceIdentity, right: DeviceIdentity): boolean {
    if (left.fingerprint && right.fingerprint) {
      return left.fingerprint === right.fingerprint;
    }

    if (left.fingerprint || right.fingerprint) {
      return false;
    }

    return left.normalizedName.length > 0 && left.normalizedName === right.normalizedName;
  }

  private async findExistingPairedDeviceByIdentity(
    userId: string,
    platform: string,
    clientId: string | null,
    identity: DeviceIdentity,
    excludeDeviceId?: string
  ): Promise<{ id: string; name: string; deviceToken: string | null } | null> {
    if (!identity.fingerprint && !identity.normalizedName) {
      return null;
    }

    const rows = await this.prisma.device.findMany({
      where: {
        userId,
        platform,
        pairedAt: {
          not: null
        },
        clientId,
        ...(excludeDeviceId ? { id: { not: excludeDeviceId } } : {})
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        deviceToken: true
      },
      take: 200
    });

    const matched = rows.find((row) =>
      this.matchesDeviceIdentity(this.resolveDeviceIdentity(row.name), identity)
    );
    return matched ?? null;
  }

  private async cleanupStalePairingArtifacts(): Promise<void> {
    const expiredCutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const orphanDeviceCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await this.prisma.$transaction([
      this.prisma.pairingSession.deleteMany({
        where: {
          OR: [
            {
              status: PairingStatus.EXPIRED
            },
            {
              status: PairingStatus.PENDING,
              expiresAt: {
                lt: new Date()
              }
            }
          ],
          createdAt: {
            lt: expiredCutoff
          }
        }
      }),
      this.prisma.device.deleteMany({
        where: {
          userId: null,
          pairedAt: null,
          createdAt: {
            lt: orphanDeviceCutoff
          },
          pairingSessions: {
            none: {}
          }
        }
      })
    ]);
  }

  private async generateUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = randomBytes(4)
        .toString('base64')
        .replace(/[^A-Z0-9]/gi, '')
        .slice(0, 6)
        .toUpperCase();

      const exists = await this.prisma.pairingSession.findUnique({ where: { code } });
      if (!exists) {
        return code;
      }
    }

    throw new Error('Failed to generate unique pairing code');
  }

  private asStringArray(rawValue: unknown): string[] {
    if (!Array.isArray(rawValue)) {
      return [];
    }

    const rows: string[] = [];
    const unique = new Set<string>();
    for (const item of rawValue) {
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
}
