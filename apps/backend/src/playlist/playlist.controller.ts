import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PlaylistService } from './playlist.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { SetPlaylistUrlDto } from './dto/set-playlist-url.dto';
import { CreateCustomPlaylistDto } from './dto/create-custom-playlist.dto';
import { UpdateCustomPlaylistDto } from './dto/update-custom-playlist.dto';
import { SetCustomPlaylistChannelsDto } from './dto/set-custom-playlist-channels.dto';
import { CreateBasePlaylistDto } from './dto/create-base-playlist.dto';
import { CreateBasePlaylistFromFileDto } from './dto/create-base-playlist-from-file.dto';
import { UpdateBasePlaylistDto } from './dto/update-base-playlist.dto';

@ApiTags('playlist')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('playlist')
export class PlaylistController {
  constructor(@Inject(PlaylistService) private readonly playlistService: PlaylistService) {}

  @Post('set-url')
  setUrl(@CurrentUser() user: { sub: string }, @Body() dto: SetPlaylistUrlDto) {
    return this.playlistService.setPlaylistUrl(user.sub, dto.url);
  }

  @Get('sources')
  sources(@CurrentUser() user: { sub: string }) {
    return this.playlistService.listBasePlaylistsForUser(user.sub);
  }

  @Post('sources')
  createSource(@CurrentUser() user: { sub: string }, @Body() dto: CreateBasePlaylistDto) {
    return this.playlistService.createBasePlaylistForUser(user.sub, dto.name, dto.url);
  }

  @Post('sources/upload')
  createSourceFromFile(
    @CurrentUser() user: { sub: string },
    @Body() dto: CreateBasePlaylistFromFileDto
  ) {
    return this.playlistService.createBasePlaylistFromFileForUser(
      user.sub,
      dto.name,
      dto.fileName,
      dto.content
    );
  }

  @Patch('sources/:id')
  updateSource(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBasePlaylistDto
  ) {
    return this.playlistService.updateBasePlaylistForUser(user.sub, id, dto);
  }

  @Delete('sources/:id')
  deleteSource(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.playlistService.deleteBasePlaylistForUser(user.sub, id);
  }

  @Post('sources/:id/refresh')
  refreshSource(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.playlistService.refreshBasePlaylistForUser(user.sub, id);
  }

  @Get('status')
  status(@CurrentUser() user: { sub: string }) {
    return this.playlistService.getPlaylistStatus(user.sub);
  }

  @Get('channels')
  channels(@CurrentUser() user: { sub: string }) {
    return this.playlistService.getSourceChannelsForUser(user.sub);
  }

  @Get('custom')
  customPlaylists(@CurrentUser() user: { sub: string }) {
    return this.playlistService.listCustomPlaylistsForUser(user.sub);
  }

  @Post('custom')
  createCustomPlaylist(@CurrentUser() user: { sub: string }, @Body() dto: CreateCustomPlaylistDto) {
    return this.playlistService.createCustomPlaylistForUser(user.sub, dto.name);
  }

  @Patch('custom/:id')
  updateCustomPlaylist(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomPlaylistDto
  ) {
    return this.playlistService.renameCustomPlaylistForUser(user.sub, id, dto.name);
  }

  @Delete('custom/:id')
  deleteCustomPlaylist(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.playlistService.deleteCustomPlaylistForUser(user.sub, id);
  }

  @Get('custom/:id/channels')
  customPlaylistChannels(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.playlistService.getCustomPlaylistDetailForUser(user.sub, id);
  }

  @Put('custom/:id/channels')
  setCustomPlaylistChannels(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetCustomPlaylistChannelsDto
  ) {
    return this.playlistService.setCustomPlaylistChannelsForUser(user.sub, id, dto.channelIds);
  }

  @Post('custom/:id/activate')
  activateCustomPlaylist(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.playlistService.activateCustomPlaylistForUser(user.sub, id);
  }

  @Post('activate-source')
  activateSourcePlaylist(@CurrentUser() user: { sub: string }) {
    return this.playlistService.activateSourcePlaylistForUser(user.sub);
  }
}
