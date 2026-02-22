import { Module } from '@nestjs/common';
import { EpgController } from './epg.controller';
import { EpgService } from './epg.service';
import { OttCatalogModule } from '../ott-catalog/ott-catalog.module';

@Module({
  imports: [OttCatalogModule],
  providers: [EpgService],
  controllers: [EpgController],
  exports: [EpgService]
})
export class EpgModule {}
