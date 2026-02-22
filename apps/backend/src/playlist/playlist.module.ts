import { Module } from '@nestjs/common';
import { PlaylistController } from './playlist.controller';
import { PlaylistService } from './playlist.service';
import { OttCatalogModule } from '../ott-catalog/ott-catalog.module';

@Module({
  imports: [OttCatalogModule],
  controllers: [PlaylistController],
  providers: [PlaylistService],
  exports: [PlaylistService]
})
export class PlaylistModule {}
