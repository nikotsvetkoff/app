import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListChannelsQueryDto {
  @IsOptional()
  @IsString({ message: 'search должен быть строкой' })
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit должен быть целым числом' })
  @Min(1, { message: 'limit должен быть не меньше 1' })
  @Max(2000, { message: 'limit должен быть не больше 2000' })
  limit?: number;
}
