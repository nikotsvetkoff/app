import { ApiProperty } from '@nestjs/swagger';
import { IsUrl, MaxLength } from 'class-validator';

export class SetPlaylistUrlDto {
  @ApiProperty({ example: 'https://example.com/playlist.m3u' })
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Укажите корректный URL плейлиста (http/https)' }
  )
  @MaxLength(2048, { message: 'URL плейлиста не должен превышать 2048 символов' })
  url!: string;
}
