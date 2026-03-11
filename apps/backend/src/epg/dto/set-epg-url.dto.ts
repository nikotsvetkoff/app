import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class SetEpgUrlDto {
  @ApiProperty({
    example: 'https://example.com/guide.xml.gz\nhttps://iptv-epg.org/guides',
    description: 'Un URL per linie. Poti insera si mai multe URL-uri in acelasi text.'
  })
  @IsString({ message: 'URL EPG trebuie sa fie text.' })
  @MaxLength(8192, { message: 'Lista URL EPG nu trebuie sa depaseasca 8192 caractere.' })
  url!: string;
}
