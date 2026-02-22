import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OttCatalogController } from './ott-catalog.controller';
import { OttCatalogService } from './ott-catalog.service';

@Module({
  imports: [PrismaModule],
  controllers: [OttCatalogController],
  providers: [OttCatalogService],
  exports: [OttCatalogService]
})
export class OttCatalogModule {}
