import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCustomPlaylistDto {
  @ApiProperty({ example: 'Избранные новости' })
  @IsString({ message: 'name must be a string' })
  @MinLength(1, { message: 'name is required' })
  @MaxLength(120, { message: 'name is too long' })
  name!: string;
}

