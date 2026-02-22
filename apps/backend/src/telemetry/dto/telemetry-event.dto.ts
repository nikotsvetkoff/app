import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, MaxLength } from 'class-validator';

export class TelemetryEventDto {
  @ApiProperty({ example: 'playback_error' })
  @IsString({ message: 'Тип события должен быть строкой' })
  @MaxLength(128, { message: 'Тип события не должен превышать 128 символов' })
  type!: string;

  @ApiProperty({
    example: {
      message: 'HLS parser error',
      code: 'PLAYER_1003'
    }
  })
  @IsObject({ message: 'payload должен быть объектом' })
  payload!: Record<string, unknown>;
}
