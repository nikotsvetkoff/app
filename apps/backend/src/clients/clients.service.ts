import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PairingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateClientDto } from './dto/create-client.dto';
import type { UpdateClientDto } from './dto/update-client.dto';

interface ClientWithDevices {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  devicesAllowed: number;
  sourcePlaylistIds: unknown;
  createdAt: Date;
  updatedAt: Date;
  devices: Array<{ id: string }>;
}

export interface ClientListItem {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  devicesAllowed: number;
  sourcePlaylistIds: string[];
  pairedDevices: number;
  createdAt: string;
  updatedAt: string;
}

export interface ClientPairingHistoryItem {
  pairingId: string;
  code: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

const stripDeviceIpTag = (deviceName: string): string =>
  deviceName.replace(/\s*\[IP:\s*[^\]]+\]\s*$/i, '').trim();

@Injectable()
export class ClientsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<ClientListItem[]> {
    const rows = await this.prisma.client.findMany({
      where: { userId },
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
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }]
    });

    return rows.map((row) => this.toListItem(row));
  }

  async createForUser(userId: string, dto: CreateClientDto): Promise<ClientListItem> {
    const sourcePlaylistIds =
      (await this.normalizeSourcePlaylistIdsForUser(userId, dto.sourcePlaylistIds)) ?? [];

    const created = await this.prisma.client.create({
      data: {
        userId,
        firstName: this.requiredTrimmed(dto.firstName, 'firstName'),
        lastName: this.requiredTrimmed(dto.lastName, 'lastName'),
        phone: this.requiredTrimmed(dto.phone, 'phone'),
        address: this.requiredTrimmed(dto.address, 'address'),
        devicesAllowed: dto.devicesAllowed,
        sourcePlaylistIds: sourcePlaylistIds as unknown as Prisma.InputJsonValue
      }
    });

    return this.getByIdForUser(userId, created.id);
  }

  async updateForUser(userId: string, clientId: string, dto: UpdateClientDto): Promise<ClientListItem> {
    await this.assertClientOwner(userId, clientId);

    const data: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      address?: string;
      devicesAllowed?: number;
      sourcePlaylistIds?: Prisma.InputJsonValue;
    } = {};

    if (dto.firstName !== undefined) {
      data.firstName = this.requiredTrimmed(dto.firstName, 'firstName');
    }
    if (dto.lastName !== undefined) {
      data.lastName = this.requiredTrimmed(dto.lastName, 'lastName');
    }
    if (dto.phone !== undefined) {
      data.phone = this.requiredTrimmed(dto.phone, 'phone');
    }
    if (dto.address !== undefined) {
      data.address = this.requiredTrimmed(dto.address, 'address');
    }
    if (dto.devicesAllowed !== undefined) {
      data.devicesAllowed = dto.devicesAllowed;
    }
    if (dto.sourcePlaylistIds !== undefined) {
      const sourcePlaylistIds = await this.normalizeSourcePlaylistIdsForUser(
        userId,
        dto.sourcePlaylistIds
      );
      data.sourcePlaylistIds = (sourcePlaylistIds ?? []) as unknown as Prisma.InputJsonValue;
    }

    if (!Object.keys(data).length) {
      throw new BadRequestException('No fields provided for update');
    }

    await this.prisma.client.update({
      where: { id: clientId },
      data
    });

    return this.getByIdForUser(userId, clientId);
  }

  async deleteForUser(userId: string, clientId: string): Promise<{ success: true }> {
    await this.assertClientOwner(userId, clientId);

    await this.prisma.$transaction([
      this.prisma.pairingSession.deleteMany({
        where: {
          userId,
          device: {
            clientId
          }
        }
      }),
      this.prisma.device.deleteMany({
        where: {
          userId,
          clientId
        }
      }),
      this.prisma.client.delete({
        where: { id: clientId }
      })
    ]);

    return { success: true };
  }

  async getPairingHistoryForUser(userId: string, clientId: string): Promise<ClientPairingHistoryItem[]> {
    await this.assertClientOwner(userId, clientId);

    const rows = await this.prisma.pairingSession.findMany({
      where: {
        userId,
        status: PairingStatus.PAIRED,
        device: {
          clientId
        }
      },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            platform: true,
            pairedAt: true,
            lastSeenAt: true
          }
        }
      },
      orderBy: [{ confirmedAt: 'desc' }, { createdAt: 'desc' }]
    });

    return rows.map((row) => ({
      pairingId: row.id,
      code: row.code,
      deviceId: row.device.id,
      deviceName: stripDeviceIpTag(row.device.name),
      platform: row.device.platform,
      pairedAt: (row.confirmedAt ?? row.device.pairedAt ?? row.createdAt).toISOString(),
      lastSeenAt: row.device.lastSeenAt ? row.device.lastSeenAt.toISOString() : null
    }));
  }

  private async getByIdForUser(userId: string, clientId: string): Promise<ClientListItem> {
    const row = await this.prisma.client.findFirst({
      where: {
        id: clientId,
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

    if (!row) {
      throw new NotFoundException('Client not found');
    }

    return this.toListItem(row);
  }

  private toListItem(row: ClientWithDevices): ClientListItem {
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      phone: row.phone,
      address: row.address,
      devicesAllowed: row.devicesAllowed,
      sourcePlaylistIds: this.asStringArray(row.sourcePlaylistIds),
      pairedDevices: row.devices.length,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  private async assertClientOwner(userId: string, clientId: string): Promise<void> {
    const exists = await this.prisma.client.findFirst({
      where: {
        id: clientId,
        userId
      },
      select: {
        id: true
      }
    });

    if (!exists) {
      throw new NotFoundException('Client not found');
    }
  }

  private requiredTrimmed(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`Field ${field} is required`);
    }
    return normalized;
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

  private async normalizeSourcePlaylistIdsForUser(
    userId: string,
    rawIds: string[] | undefined
  ): Promise<string[] | undefined> {
    if (rawIds === undefined) {
      return undefined;
    }

    const normalized = this.asStringArray(rawIds);
    if (normalized.length === 0) {
      return [];
    }

    const existing = await this.prisma.basePlaylist.findMany({
      where: {
        userId,
        id: {
          in: normalized
        }
      },
      select: {
        id: true
      }
    });
    const existingIds = new Set(existing.map((row) => row.id));
    const missing = normalized.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundException('One or more source playlists were not found');
    }

    return normalized;
  }
}
