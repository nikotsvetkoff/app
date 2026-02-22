import { ApiProperty } from '@nestjs/swagger';
import { IsUrl, MaxLength } from 'class-validator';

export class SetEpgUrlDto {
  @ApiProperty({ example: 'https://example.com/guide.xml' })
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'Укажите корректный URL EPG (http/https)' }
  )
  @MaxLength(2048, { message: 'URL EPG не должен превышать 2048 символов' })
  url!: string;
}
