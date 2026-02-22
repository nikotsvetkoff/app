import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateClientDto {
  @ApiPropertyOptional({ example: 'Ion' })
  @IsOptional()
  @IsString({ message: 'Имя должно быть строкой' })
  @IsNotEmpty({ message: 'Имя обязательно' })
  @MaxLength(80, { message: 'Имя не должно превышать 80 символов' })
  firstName?: string;

  @ApiPropertyOptional({ example: 'Popescu' })
  @IsOptional()
  @IsString({ message: 'Фамилия должна быть строкой' })
  @IsNotEmpty({ message: 'Фамилия обязательна' })
  @MaxLength(80, { message: 'Фамилия не должна превышать 80 символов' })
  lastName?: string;

  @ApiPropertyOptional({ example: '+37360111222' })
  @IsOptional()
  @IsString({ message: 'Телефон должен быть строкой' })
  @IsNotEmpty({ message: 'Телефон обязателен' })
  @MaxLength(40, { message: 'Телефон не должен превышать 40 символов' })
  phone?: string;

  @ApiPropertyOptional({ example: 'Str. Independentei 10, Chisinau' })
  @IsOptional()
  @IsString({ message: 'Адрес должен быть строкой' })
  @IsNotEmpty({ message: 'Адрес обязателен' })
  @MaxLength(240, { message: 'Адрес не должен превышать 240 символов' })
  address?: string;

  @ApiPropertyOptional({ example: 3, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt({ message: 'Количество устройств должно быть целым числом' })
  @Min(1, { message: 'Количество устройств должно быть не меньше 1' })
  @Max(20, { message: 'Количество устройств должно быть не больше 20' })
  devicesAllowed?: number;
}
