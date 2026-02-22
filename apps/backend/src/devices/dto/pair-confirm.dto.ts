import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';

const PLAYLIST_MODES = ['GLOBAL', 'SOURCE', 'CUSTOM'] as const;

export class PairConfirmDto {
  @ApiProperty({ example: 'A1B2C3' })
  @IsString({ message: 'Pairing code must be a string' })
  @Length(6, 8, { message: 'Pairing code length must be between 6 and 8 symbols' })
  code!: string;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Optional client owner for this paired device'
  })
  @IsOptional()
  @IsUUID('4', { message: 'clientId must be UUID v4' })
  clientId?: string;

  @ApiPropertyOptional({
    enum: PLAYLIST_MODES,
    description: 'Playlist mode for this device (GLOBAL by default)'
  })
  @IsOptional()
  @IsIn(PLAYLIST_MODES, { message: 'playlistMode must be GLOBAL, SOURCE or CUSTOM' })
  playlistMode?: (typeof PLAYLIST_MODES)[number];

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Custom playlist id when playlistMode=CUSTOM'
  })
  @IsOptional()
  @IsUUID('4', { message: 'customPlaylistId must be UUID v4' })
  customPlaylistId?: string;
}
