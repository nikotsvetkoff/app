import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class SyncOptionsDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'force должен быть логическим значением (true/false)' })
  force?: boolean;
}
