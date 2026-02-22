import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class PairConfirmDto {
  @ApiProperty({ example: 'A1B2C3' })
  @IsString({ message: 'Код привязки должен быть строкой' })
  @Length(6, 8, { message: 'Код привязки должен содержать от 6 до 8 символов' })
  code!: string;

  @ApiPropertyOptional({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Optional client owner for this paired device'
  })
  @IsOptional()
  @IsUUID('4', { message: 'clientId должен быть UUID v4' })
  clientId?: string;
}
