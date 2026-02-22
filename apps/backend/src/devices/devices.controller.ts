import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DevicesService } from './devices.service';
import { PairStartDto } from './dto/pair-start.dto';
import { PairConfirmDto } from './dto/pair-confirm.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';

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
    return this.devicesService.confirmPairing(dto.code.toUpperCase(), user.sub, dto.clientId);
  }

  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Get('pair/status')
  status(@Query('code') code: string) {
    return this.devicesService.getPairingStatus((code ?? '').toUpperCase());
  }
}
