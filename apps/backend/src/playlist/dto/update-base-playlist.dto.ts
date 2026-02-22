import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UpdateBasePlaylistDto {
  @ApiPropertyOptional({ example: 'Архивные каналы' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Playlist name cannot be empty' })
  @MaxLength(120, { message: 'Playlist name must be 120 characters or less' })
  name?: string;

  @ApiPropertyOptional({ example: 'https://example.com/archive.m3u8' })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'Playlist URL must be http/https' })
  @MaxLength(2048, { message: 'Playlist URL must be 2048 characters or less' })
  url?: string;
}
