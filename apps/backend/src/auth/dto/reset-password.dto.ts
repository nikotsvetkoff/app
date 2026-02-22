import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: '7f1df7930bba4cbeb8cd8396f220d5f0d0fca0c19502a7965e16007a9f0c2cf8'
  })
  @IsString({ message: 'token must be a string' })
  @MinLength(16, { message: 'token is invalid' })
  token!: string;

  @ApiProperty({ example: 'newSecret1234', minLength: 8 })
  @IsString({ message: 'password must be a string' })
  @MinLength(8, { message: 'password must contain at least 8 characters' })
  password!: string;
}
