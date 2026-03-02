import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

const PLAYLIST_MODES = ['GLOBAL', 'SOURCE', 'CUSTOM'] as const;

export class UpdateDevicePlaylistDto {
  @ApiPropertyOptional({ enum: PLAYLIST_MODES, default: 'GLOBAL' })
  @IsOptional()
  @IsIn(PLAYLIST_MODES, { message: 'playlistMode must be GLOBAL, SOURCE or CUSTOM' })
  playlistMode?: (typeof PLAYLIST_MODES)[number];

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Custom playlist id when playlistMode=CUSTOM or source playlist id when playlistMode=SOURCE'
  })
  @IsOptional()
  @IsUUID('4', { message: 'customPlaylistId must be UUID v4' })
  customPlaylistId?: string;
}
