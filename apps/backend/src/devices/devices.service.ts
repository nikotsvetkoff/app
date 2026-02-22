import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PairingStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { PairStartDto } from './dto/pair-start.dto';

export interface PairingStartResponse {
  code: string;
  expiresAt: string;
  pollIntervalSec: number;
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

  async confirmPairing(code: string, userId: string, clientId?: string): Promise<{ success: true }> {
    const pairing = await this.prisma.pairingSession.findUnique({
      where: { code },
      include: { device: true }
    });

    if (!pairing) {
      throw new NotFoundException('Код привязки не найден');
    }

    if (pairing.expiresAt.getTime() < Date.now()) {
      await this.prisma.pairingSession.update({
        where: { id: pairing.id },
        data: { status: PairingStatus.EXPIRED }
      });
      throw new ConflictException('Срок действия кода привязки истек');
    }

    if (pairing.status === PairingStatus.PAIRED) {
      throw new ConflictException('Код привязки уже использован');
    }

    let assignedClientId: string | null = null;
    if (clientId) {
      const client = await this.prisma.client.findFirst({
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

      if (!client) {
        throw new NotFoundException('Клиент не найден');
      }

      if (client.devices.length >= client.devicesAllowed) {
        throw new ConflictException(
          `Для клиента достигнут лимит устройств (${client.devicesAllowed}). Увеличьте лимит в админке.`
        );
      }

      assignedClientId = client.id;
    }

    const deviceToken = pairing.device.deviceToken ?? randomBytes(32).toString('base64url');

    await this.prisma.$transaction([
      this.prisma.device.update({
        where: { id: pairing.deviceId },
        data: {
          userId,
          pairedAt: new Date(),
          deviceToken,
          clientId: assignedClientId
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
      throw new NotFoundException('Код привязки не найден');
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

  async getDeviceById(id: string) {
    return this.prisma.device.findUnique({ where: { id } });
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

    throw new Error('Не удалось сгенерировать уникальный код привязки');
  }
}
