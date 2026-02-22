import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DeviceTokenGuard } from '../common/device-token.guard';
import { CurrentDevice, type DeviceAuthContext } from '../common/request-context';
import { PlaylistService } from '../playlist/playlist.service';
import { EpgService } from '../epg/epg.service';

@ApiTags('device')
@ApiSecurity('device-token')
@UseGuards(DeviceTokenGuard)
@Controller('device')
export class DeviceApiController {
  constructor(
    @Inject(PlaylistService) private readonly playlistService: PlaylistService,
    @Inject(EpgService) private readonly epgService: EpgService
  ) {}

  @Get('profile')
  profile(@CurrentDevice() device: DeviceAuthContext) {
    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      paired: Boolean(device.userId)
    };
  }

  @Get('playlist')
  async playlist(@CurrentDevice() device: DeviceAuthContext) {
    const channels = await this.playlistService.getChannelsForDevice(device.id);
    return { channels };
  }

  @Get('epg/now-next')
  async nowNext(@CurrentDevice() device: DeviceAuthContext) {
    const channels = await this.playlistService.getChannelsForDevice(device.id);
    const items = await this.epgService.getNowNextForDevice(device.id, channels);
    return { items };
  }

  @Get('epg/day')
  async day(@CurrentDevice() device: DeviceAuthContext, @Query('date') date: string) {
    const channels = await this.playlistService.getChannelsForDevice(device.id);
    const items = await this.epgService.getDayGridForDevice(device.id, channels, date);
    return { items };
  }
}
