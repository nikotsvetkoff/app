import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min
} from 'class-validator';

export class CreateClientDto {
  @ApiProperty({ example: 'Ion' })
  @IsString({ message: 'firstName must be a string' })
  @IsNotEmpty({ message: 'firstName is required' })
  @MaxLength(80, { message: 'firstName must be at most 80 chars' })
  firstName!: string;

  @ApiProperty({ example: 'Popescu' })
  @IsString({ message: 'lastName must be a string' })
  @IsNotEmpty({ message: 'lastName is required' })
  @MaxLength(80, { message: 'lastName must be at most 80 chars' })
  lastName!: string;

  @ApiProperty({ example: '+37360111222' })
  @IsString({ message: 'phone must be a string' })
  @IsNotEmpty({ message: 'phone is required' })
  @MaxLength(40, { message: 'phone must be at most 40 chars' })
  phone!: string;

  @ApiProperty({ example: 'Str. Independentei 10, Chisinau' })
  @IsString({ message: 'address must be a string' })
  @IsNotEmpty({ message: 'address is required' })
  @MaxLength(240, { message: 'address must be at most 240 chars' })
  address!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 20 })
  @IsInt({ message: 'devicesAllowed must be an integer' })
  @Min(1, { message: 'devicesAllowed must be >= 1' })
  @Max(20, { message: 'devicesAllowed must be <= 20' })
  devicesAllowed!: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Base playlist ids available for this subscriber',
    example: ['0d4b6624-12f9-4fd1-a7fd-b29631f9c6d2', '7bf2d3d0-a06e-41ff-9040-a7ef4f7be8d3']
  })
  @IsOptional()
  @IsArray({ message: 'sourcePlaylistIds must be an array' })
  @ArrayMaxSize(100, { message: 'sourcePlaylistIds must have at most 100 entries' })
  @IsUUID('4', { each: true, message: 'sourcePlaylistIds entries must be UUID v4' })
  sourcePlaylistIds?: string[];
}
