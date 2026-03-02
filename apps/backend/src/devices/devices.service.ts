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

const PLAYLIST_MODES = ['GLOBAL', 'SOURCE', 'CUSTOM'] as const;
type DevicePlaylistMode = (typeof PLAYLIST_MODES)[number];

interface DevicePlaylistAssignment {
  playlistMode: DevicePlaylistMode;
  customPlaylistId: string | null;
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

@Injectable()
export class DevicesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {}

  async startPairing(dto: PairStartDto): Promise<PairingStartResponse> {
    const code = await this.generateUniqueCode();
    const ttlSec = Number(this.configService.get('PAIRING_CODE_TTL_SEC') ?? 600);
    const pollIntervalSec = Number(this.configService.get('PAIRING_POLL_INTERVAL_SEC') ?? 3);
    const expiresAt = new Date(Date.now() + ttlSec * 1000);

    const device = await this.prisma.device.create({
      data: {
        name: dto.deviceName,
        platform: dto.platform
      }
    });

    await this.prisma.pairingSession.create({
      data: {
        code,
        deviceId: device.id,
        expiresAt,
        pollIntervalSec,
        status: PairingStatus.PENDING
      }
    });

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
    let pairedClientId: string | null = null;

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

      if (client.devices.length >= client.devicesAllowed) {
        throw new ConflictException(
          `Client reached devices limit (${client.devicesAllowed}). Increase limit in admin.`
        );
      }

      pairedClientId = client.id;
    }

    const assignment = await this.resolveDevicePlaylistAssignment(
      userId,
      playlistMode,
      customPlaylistId
    );
    const deviceToken = pairing.device.deviceToken ?? randomBytes(32).toString('base64url');

    await this.prisma.$transaction([
      this.prisma.device.update({
        where: { id: pairing.deviceId },
        data: {
          userId,
          pairedAt: new Date(),
          deviceToken,
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
          confirmedAt: new Date()
        }
      })
    ]);

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
              lastName: true
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
      const sourceName = sourceId ? (sourceNameById.get(sourceId) ?? null) : null;
      const clientName = device.client
        ? `${device.client.lastName} ${device.client.firstName}`.trim()
        : null;

      return {
        id: device.id,
        name: device.name,
        platform: device.platform,
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
}
