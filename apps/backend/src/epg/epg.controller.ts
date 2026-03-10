import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EpgService } from './epg.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { SetEpgUrlDto } from './dto/set-epg-url.dto';

@ApiTags('epg')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('epg')
export class EpgController {
  constructor(@Inject(EpgService) private readonly epgService: EpgService) {}

  @Post('set-url')
  setUrl(@CurrentUser() user: { sub: string }, @Body() dto: SetEpgUrlDto) {
    return this.epgService.setEpgUrl(user.sub, dto.url);
  }

  @Get('status')
  status(@CurrentUser() user: { sub: string }) {
    return this.epgService.getEpgStatus(user.sub);
  }

  @Post('upload-gz')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        fileSize: 80_000_000
      }
    })
  )
  uploadGz(
    @CurrentUser() user: { sub: string },
    @UploadedFile()
    file?:
      | {
          buffer: Buffer;
          originalname?: string;
          size?: number;
          mimetype?: string;
        }
      | undefined
  ) {
    return this.epgService.uploadXmlTvGzip(user.sub, file);
  }
}
