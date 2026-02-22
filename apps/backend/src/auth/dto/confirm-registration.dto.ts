import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class ConfirmRegistrationDto {
  @ApiProperty({
    example: '12345678'
  })
  @IsString({ message: 'token must be a string' })
  @Matches(/^\d{8}$/, { message: 'token is invalid' })
  token!: string;
}
