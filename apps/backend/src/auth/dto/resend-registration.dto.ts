import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ResendRegistrationDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail({}, { message: 'Invalid email format' })
  email!: string;
}
