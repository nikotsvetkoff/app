import { Module } from '@nestjs/common';
import { PlaylistModule } from '../playlist/playlist.module';
import { SystemController } from './system.controller';
import { SystemStateService } from './system-state.service';
import { SystemService } from './system.service';

@Module({
  imports: [PlaylistModule],
  providers: [SystemService, SystemStateService],
  controllers: [SystemController],
  exports: [SystemService, SystemStateService]
})
export class SystemModule {}
