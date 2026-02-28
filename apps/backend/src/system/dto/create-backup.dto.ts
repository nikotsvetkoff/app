import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBackupDto {
  @ApiPropertyOptional({
    description: 'Backup reason label',
    example: 'manual'
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reason?: string;
}
