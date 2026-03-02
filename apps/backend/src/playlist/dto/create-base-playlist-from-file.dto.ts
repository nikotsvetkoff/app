import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateBasePlaylistFromFileDto {
  @ApiProperty({ example: 'Основной пакет' })
  @IsString()
  @IsNotEmpty({ message: 'Playlist name is required' })
  @MaxLength(120, { message: 'Playlist name must be 120 characters or less' })
  name!: string;

  @ApiProperty({ example: 'playlist.m3u8' })
  @IsString()
  @IsNotEmpty({ message: 'File name is required' })
  @MaxLength(255, { message: 'File name must be 255 characters or less' })
  fileName!: string;

  @ApiProperty({ example: '#EXTM3U\n#EXTINF:-1,Channel\nhttps://example.com/live/stream.m3u8' })
  @IsString()
  @IsNotEmpty({ message: 'Playlist content is required' })
  @MaxLength(2_000_000, { message: 'Playlist file is too large' })
  content!: string;
}
