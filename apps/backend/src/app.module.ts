import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { DevicesModule } from './devices/devices.module';
import { PlaylistModule } from './playlist/playlist.module';
import { EpgModule } from './epg/epg.module';
import { DeviceApiModule } from './device/device-api.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AppController } from './app.controller';
import { ClientsModule } from './clients/clients.module';
import { AdminsModule } from './admins/admins.module';
import { OttCatalogModule } from './ott-catalog/ott-catalog.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local']
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 120
      }
    ]),
    PrismaModule,
    UsersModule,
    AuthModule,
    DevicesModule,
    PlaylistModule,
    EpgModule,
    DeviceApiModule,
    ClientsModule,
    AdminsModule,
    OttCatalogModule,
    TelemetryModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard
    }
  ]
})
export class AppModule {}
