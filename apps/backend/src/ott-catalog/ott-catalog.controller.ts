import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { OttCatalogService } from './ott-catalog.service';
import { SyncOptionsDto } from './dto/sync-options.dto';
import { ListChannelsQueryDto } from './dto/list-channels.query.dto';
import { ListProgramsQueryDto } from './dto/list-programs.query.dto';
import { SyncProviderProgramsDto } from './dto/sync-provider-programs.dto';
import { SyncFullDto } from './dto/sync-full.dto';

@ApiTags('ott-catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('ott-catalog')
export class OttCatalogController {
  constructor(@Inject(OttCatalogService) private readonly ottCatalogService: OttCatalogService) {}

  @Get('stats')
  stats(@CurrentUser() user: { sub: string }) {
    return this.ottCatalogService.getStats(user.sub);
  }

  @Get('providers')
  listProviders(@CurrentUser() user: { sub: string }) {
    return this.ottCatalogService.listProviders(user.sub);
  }

  @Post('providers/sync')
  syncProviders(@CurrentUser() user: { sub: string }, @Body() dto: SyncOptionsDto) {
    return this.ottCatalogService.syncProviders(user.sub, dto.force ?? false);
  }

  @Post('sync/full')
  syncFull(@CurrentUser() user: { sub: string }, @Body() dto: SyncFullDto) {
    return this.ottCatalogService.syncFullCatalog(user.sub, {
      force: dto.force,
      providerLimit: dto.providerLimit,
      channelsPerProvider: dto.channelsPerProvider,
      delayMs: dto.delayMs
    });
  }

  @Get('providers/:providerId/channels')
  listChannels(
    @CurrentUser() user: { sub: string },
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Query() query: ListChannelsQueryDto
  ) {
    return this.ottCatalogService.listChannels(
      user.sub,
      providerId,
      query.search ?? '',
      query.limit ?? 200
    );
  }

  @Post('providers/:providerId/channels/sync')
  syncProviderChannels(
    @CurrentUser() user: { sub: string },
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() dto: SyncOptionsDto
  ) {
    return this.ottCatalogService.syncProviderChannels(user.sub, providerId, dto.force ?? false);
  }

  @Post('providers/:providerId/programs/sync')
  syncProviderPrograms(
    @CurrentUser() user: { sub: string },
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() dto: SyncProviderProgramsDto
  ) {
    return this.ottCatalogService.syncProviderPrograms(user.sub, providerId, {
      force: dto.force,
      limitChannels: dto.limitChannels,
      delayMs: dto.delayMs
    });
  }

  @Get('channels/:channelId/programs')
  listPrograms(
    @CurrentUser() user: { sub: string },
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query() query: ListProgramsQueryDto
  ) {
    return this.ottCatalogService.listPrograms(user.sub, channelId, query.limit ?? 250);
  }

  @Post('channels/:channelId/programs/sync')
  syncChannelPrograms(
    @CurrentUser() user: { sub: string },
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() dto: SyncOptionsDto
  ) {
    return this.ottCatalogService.syncChannelPrograms(user.sub, channelId, dto.force ?? false);
  }
}
