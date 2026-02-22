import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SyncFullDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'force должен быть логическим значением (true/false)' })
  force?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'providerLimit должен быть целым числом' })
  @Min(1, { message: 'providerLimit должен быть не меньше 1' })
  @Max(100, { message: 'providerLimit должен быть не больше 100' })
  providerLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'channelsPerProvider должен быть целым числом' })
  @Min(1, { message: 'channelsPerProvider должен быть не меньше 1' })
  @Max(500, { message: 'channelsPerProvider должен быть не больше 500' })
  channelsPerProvider?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'delayMs должен быть целым числом' })
  @Min(0, { message: 'delayMs должен быть не меньше 0' })
  @Max(5000, { message: 'delayMs должен быть не больше 5000' })
  delayMs?: number;
}
