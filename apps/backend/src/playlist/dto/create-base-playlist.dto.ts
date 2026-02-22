import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateBasePlaylistDto {
  @ApiProperty({ example: 'Основной пакет' })
  @IsString()
  @IsNotEmpty({ message: 'Playlist name is required' })
  @MaxLength(120, { message: 'Playlist name must be 120 characters or less' })
  name!: string;

  @ApiProperty({ example: 'https://example.com/playlist.m3u8' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'Playlist URL must be http/https' })
  @MaxLength(2048, { message: 'Playlist URL must be 2048 characters or less' })
  url!: string;
}
