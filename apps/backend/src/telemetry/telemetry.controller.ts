import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DeviceTokenGuard } from '../common/device-token.guard';
import { CurrentDevice, type DeviceAuthContext } from '../common/request-context';
import { TelemetryEventDto } from './dto/telemetry-event.dto';
import { TelemetryService } from './telemetry.service';

@ApiTags('telemetry')
@ApiSecurity('device-token')
@UseGuards(DeviceTokenGuard)
@Controller('telemetry')
export class TelemetryController {
  constructor(@Inject(TelemetryService) private readonly telemetryService: TelemetryService) {}

  @Post('event')
  event(@CurrentDevice() device: DeviceAuthContext, @Body() dto: TelemetryEventDto) {
    return this.telemetryService.recordFromDevice(device.id, dto.type, dto.payload);
  }
}
