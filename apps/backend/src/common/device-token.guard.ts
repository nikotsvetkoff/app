import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithContext } from './request-context';

@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const tokenHeader =
      request.headers['x-device-token'] ?? request.headers['X-Device-Token'.toLowerCase()];
    const bearerHeader = request.headers.authorization;

    const token =
      (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader) ??
      (bearerHeader?.startsWith('Bearer ') ? bearerHeader.slice(7) : undefined);

    if (!token) {
      throw new UnauthorizedException('Токен устройства отсутствует');
    }

    const devTestToken = process.env.DEV_TEST_DEVICE_TOKEN?.trim();
    const canUseDefaultTestToken = process.env.NODE_ENV !== 'production';
    const acceptedTestToken =
      devTestToken && devTestToken.length > 0
        ? devTestToken
        : canUseDefaultTestToken
          ? 'test'
          : undefined;

    if (acceptedTestToken && token === acceptedTestToken) {
      const latestPairedDevice = await this.prisma.device.findFirst({
        where: {
          userId: {
            not: null
          }
        },
        orderBy: {
          updatedAt: 'desc'
        }
      });

      if (!latestPairedDevice || !latestPairedDevice.userId) {
        throw new UnauthorizedException(
          'Тестовый токен недоступен: сначала привяжите хотя бы одно устройство.'
        );
      }

      request.device = {
        id: latestPairedDevice.id,
        userId: latestPairedDevice.userId,
        name: latestPairedDevice.name,
        platform: latestPairedDevice.platform
      };

      await this.prisma.device.update({
        where: { id: latestPairedDevice.id },
        data: { lastSeenAt: new Date() }
      });

      return true;
    }

    const device = await this.prisma.device.findUnique({
      where: { deviceToken: token }
    });

    if (!device || !device.userId) {
      throw new UnauthorizedException('Недействительный токен устройства');
    }

    request.device = {
      id: device.id,
      userId: device.userId,
      name: device.name,
      platform: device.platform
    };

    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() }
    });

    return true;
  }
}
