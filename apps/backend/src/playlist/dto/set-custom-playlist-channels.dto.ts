import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

export class SetCustomPlaylistChannelsDto {
  @ApiProperty({
    type: [String],
    example: ['5f8cb7f6d39a8c9b', '4c7de2d78f53bca1']
  })
  @IsArray({ message: 'channelIds must be an array' })
  @ArrayMaxSize(20000, { message: 'too many channels' })
  @IsString({ each: true, message: 'channelIds must contain strings' })
  channelIds!: string[];
}

