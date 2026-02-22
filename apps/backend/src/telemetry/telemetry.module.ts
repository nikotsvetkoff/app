import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';
import { DeviceTokenGuard } from '../common/device-token.guard';

@Module({
  providers: [TelemetryService, DeviceTokenGuard],
  controllers: [TelemetryController]
})
export class TelemetryModule {}
