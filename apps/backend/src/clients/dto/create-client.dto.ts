import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateClientDto {
  @ApiProperty({ example: 'Ion' })
  @IsString({ message: 'Имя должно быть строкой' })
  @IsNotEmpty({ message: 'Имя обязательно' })
  @MaxLength(80, { message: 'Имя не должно превышать 80 символов' })
  firstName!: string;

  @ApiProperty({ example: 'Popescu' })
  @IsString({ message: 'Фамилия должна быть строкой' })
  @IsNotEmpty({ message: 'Фамилия обязательна' })
  @MaxLength(80, { message: 'Фамилия не должна превышать 80 символов' })
  lastName!: string;

  @ApiProperty({ example: '+37360111222' })
  @IsString({ message: 'Телефон должен быть строкой' })
  @IsNotEmpty({ message: 'Телефон обязателен' })
  @MaxLength(40, { message: 'Телефон не должен превышать 40 символов' })
  phone!: string;

  @ApiProperty({ example: 'Str. Independentei 10, Chisinau' })
  @IsString({ message: 'Адрес должен быть строкой' })
  @IsNotEmpty({ message: 'Адрес обязателен' })
  @MaxLength(240, { message: 'Адрес не должен превышать 240 символов' })
  address!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 20 })
  @IsInt({ message: 'Количество устройств должно быть целым числом' })
  @Min(1, { message: 'Количество устройств должно быть не меньше 1' })
  @Max(20, { message: 'Количество устройств должно быть не больше 20' })
  devicesAllowed!: number;
}
