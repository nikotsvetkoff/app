import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { PairStartDto } from './dto/pair-start.dto';
import { PairConfirmDto } from './dto/pair-confirm.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { UpdateDevicePlaylistDto } from './dto/update-device-playlist.dto';

@ApiTags('devices')
@Controller('devices')
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly devicesService: DevicesService) {}

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('pair/start')
  start(@Body() dto: PairStartDto) {
    return this.devicesService.startPairing(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('pair/confirm')
  confirm(@Body() dto: PairConfirmDto, @CurrentUser() user: { sub: string }) {
    return this.devicesService.confirmPairing(
      dto.code.toUpperCase(),
      user.sub,
      dto.clientId,
      dto.playlistMode,
      dto.customPlaylistId
    );
  }

  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('pair/status')
  status(@Query('code') code: string) {
    return this.devicesService.getPairingStatus((code ?? '').toUpperCase());
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('webos/restore-token')
  restoreWebOsToken(@Query('mac') macAddress: string) {
    return this.devicesService.restoreWebOsTokenByMac(macAddress);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('restore-token')
  restoreToken(
    @Query('platform') platform: string,
    @Query('fingerprint') fingerprint?: string,
    @Query('name') deviceName?: string
  ) {
    return this.devicesService.restoreTokenByFingerprint(platform, fingerprint, deviceName);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get()
  listForUser(@CurrentUser() user: { sub: string }) {
    return this.devicesService.listPairedDevicesForUser(user.sub);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id/playlist')
  updateDevicePlaylist(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDevicePlaylistDto
  ) {
    return this.devicesService.updateDevicePlaylistForUser(
      user.sub,
      id,
      dto.playlistMode,
      dto.customPlaylistId
    );
  }
}
