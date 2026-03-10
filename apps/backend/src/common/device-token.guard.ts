import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestWithContext } from './request-context';
import { getClientIpFromRequest, withDeviceIpTag } from './client-ip.util';

const stripDeviceIpTag = (value: string): string => value.replace(/\s*\[IP:\s*[^\]]+\]\s*$/i, '').trim();

const normalizeDeviceNameHeader = (value?: string): string | undefined => {
  const normalized = (value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 64);
  return normalized || undefined;
};

@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const requestIp = getClientIpFromRequest(request);
    const tokenHeader =
      request.headers['x-device-token'] ?? request.headers['X-Device-Token'.toLowerCase()];
    const nameHeader =
      request.headers['x-device-name'] ?? request.headers['X-Device-Name'.toLowerCase()];
    const bearerHeader = request.headers.authorization;

    const token =
      (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader) ??
      (bearerHeader?.startsWith('Bearer ') ? bearerHeader.slice(7) : undefined);
    const requestedDeviceName = normalizeDeviceNameHeader(
      (Array.isArray(nameHeader) ? nameHeader[0] : nameHeader) as string | undefined
    );

    if (!token) {
      throw new UnauthorizedException('Device token is missing');
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
          'Test token is unavailable until at least one paired device exists'
        );
      }
      const normalizedName =
        requestedDeviceName || stripDeviceIpTag(latestPairedDevice.name) || latestPairedDevice.name;
      const storedName = withDeviceIpTag(normalizedName, requestIp);

      request.device = {
        id: latestPairedDevice.id,
        userId: latestPairedDevice.userId,
        name: normalizedName,
        platform: latestPairedDevice.platform
      };

      await this.prisma.device.update({
        where: { id: latestPairedDevice.id },
        data: {
          lastSeenAt: new Date(),
          ...(storedName !== latestPairedDevice.name ? { name: storedName } : {})
        }
      });

      return true;
    }

    const device = await this.prisma.device.findUnique({
      where: { deviceToken: token }
    });

    if (!device || !device.userId) {
      throw new UnauthorizedException('Invalid device token');
    }

    const normalizedName = requestedDeviceName || stripDeviceIpTag(device.name) || device.name;
    const storedName = withDeviceIpTag(normalizedName, requestIp);

    request.device = {
      id: device.id,
      userId: device.userId,
      name: normalizedName,
      platform: device.platform
    };

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: new Date(),
        ...(storedName !== device.name ? { name: storedName } : {})
      }
    });

    return true;
  }
}
