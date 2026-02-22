import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const PLATFORMS = ['android-tv', 'android', 'tizen', 'webos', 'mag', 'web'];

export class PairStartDto {
  @ApiProperty({ example: 'Living Room TV' })
  @IsString({ message: 'Название устройства должно быть строкой' })
  @MaxLength(64, { message: 'Название устройства не должно превышать 64 символа' })
  deviceName!: string;

  @ApiProperty({ example: 'android', enum: PLATFORMS })
  @IsString({ message: 'Платформа должна быть строкой' })
  @IsIn(PLATFORMS, { message: `Недопустимая платформа. Допустимо: ${PLATFORMS.join(', ')}` })
  platform!: string;

  @ApiProperty({ required: false, description: 'Optional client app version' })
  @IsOptional()
  @IsString({ message: 'Версия приложения должна быть строкой' })
  appVersion?: string;
}
