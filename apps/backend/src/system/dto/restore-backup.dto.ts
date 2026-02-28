import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class RestoreBackupDto {
  @ApiProperty({ example: 'backup-2026-02-27T17-35-12-manual.json' })
  @IsString()
  @MaxLength(255)
  fileName!: string;
}
