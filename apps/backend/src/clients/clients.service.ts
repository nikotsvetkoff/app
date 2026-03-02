import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PairingStatus } from '@prisma/client';
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
    const created = await this.prisma.client.create({
      data: {
        userId,
        firstName: this.requiredTrimmed(dto.firstName, 'firstName'),
        lastName: this.requiredTrimmed(dto.lastName, 'lastName'),
        phone: this.requiredTrimmed(dto.phone, 'phone'),
        address: this.requiredTrimmed(dto.address, 'address'),
        devicesAllowed: dto.devicesAllowed
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

    if (!Object.keys(data).length) {
      throw new BadRequestException('Не переданы поля для обновления');
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
      this.prisma.device.updateMany({
        where: {
          userId,
          clientId
        },
        data: {
          userId: null,
          clientId: null,
          deviceToken: null,
          pairedAt: null,
          playlistMode: 'GLOBAL',
          customPlaylistId: null
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
      deviceName: row.device.name,
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
      throw new NotFoundException('Клиент не найден');
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
      throw new NotFoundException('Клиент не найден');
    }
  }

  private requiredTrimmed(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new BadRequestException(`Поле ${field} обязательно`);
    }
    return normalized;
  }
}
