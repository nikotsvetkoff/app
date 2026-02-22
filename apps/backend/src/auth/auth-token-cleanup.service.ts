import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthTokenCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) private readonly configService: ConfigService
  ) {
    const intervalSec = Number(this.configService.get('AUTH_TOKEN_CLEANUP_INTERVAL_SEC') ?? 900);
    this.intervalMs = Math.max(60, intervalSec) * 1000;
  }

  onModuleInit(): void {
    void this.cleanupExpiredTokens();
    this.timer = setInterval(() => {
      void this.cleanupExpiredTokens();
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();
    await Promise.allSettled([
      this.prisma.adminRegistrationRequest.deleteMany({
        where: {
          expiresAt: { lt: now }
        }
      }),
      this.prisma.passwordResetRequest.deleteMany({
        where: {
          expiresAt: { lt: now }
        }
      })
    ]);
  }
}
