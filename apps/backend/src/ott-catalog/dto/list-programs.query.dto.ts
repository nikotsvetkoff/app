import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListProgramsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit должен быть целым числом' })
  @Min(1, { message: 'limit должен быть не меньше 1' })
  @Max(5000, { message: 'limit должен быть не больше 5000' })
  limit?: number;
}
