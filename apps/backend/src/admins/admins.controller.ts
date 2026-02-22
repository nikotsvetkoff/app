import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  UseGuards
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { AdminsService } from './admins.service';

@ApiTags('admins')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admins')
export class AdminsController {
  constructor(@Inject(AdminsService) private readonly adminsService: AdminsService) {}

  @Get()
  list() {
    return this.adminsService.listAdmins();
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string
  ) {
    return this.adminsService.deleteAdmin(id, user.sub);
  }
}
