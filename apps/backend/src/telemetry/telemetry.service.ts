import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TelemetryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async recordFromDevice(
    deviceId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<{ success: true }> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });

    await this.prisma.telemetryEvent.create({
      data: {
        deviceId,
        userId: device?.userId ?? undefined,
        type,
        payload: payload as Prisma.InputJsonValue
      }
    });

    return { success: true };
  }
}
