import { Module } from '@nestjs/common';
import { DeviceApiController } from './device-api.controller';
import { PlaylistModule } from '../playlist/playlist.module';
import { EpgModule } from '../epg/epg.module';
import { DeviceTokenGuard } from '../common/device-token.guard';

@Module({
  imports: [PlaylistModule, EpgModule],
  controllers: [DeviceApiController],
  providers: [DeviceTokenGuard]
})
export class DeviceApiModule {}
