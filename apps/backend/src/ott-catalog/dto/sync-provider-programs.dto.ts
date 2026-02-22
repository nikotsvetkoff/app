import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SyncProviderProgramsDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean({ message: 'force должен быть логическим значением (true/false)' })
  force?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limitChannels должен быть целым числом' })
  @Min(1, { message: 'limitChannels должен быть не меньше 1' })
  @Max(2000, { message: 'limitChannels должен быть не больше 2000' })
  limitChannels?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'delayMs должен быть целым числом' })
  @Min(0, { message: 'delayMs должен быть не меньше 0' })
  @Max(5000, { message: 'delayMs должен быть не больше 5000' })
  delayMs?: number;
}
