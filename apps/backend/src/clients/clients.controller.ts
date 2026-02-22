import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/request-context';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';

@ApiTags('clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('clients')
export class ClientsController {
  constructor(@Inject(ClientsService) private readonly clientsService: ClientsService) {}

  @Get()
  list(@CurrentUser() user: { sub: string }) {
    return this.clientsService.listForUser(user.sub);
  }

  @Post()
  create(@CurrentUser() user: { sub: string }, @Body() dto: CreateClientDto) {
    return this.clientsService.createForUser(user.sub, dto);
  }

  @Get(':id/pairings')
  pairingHistory(@CurrentUser() user: { sub: string }, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.clientsService.getPairingHistoryForUser(user.sub, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { sub: string },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateClientDto
  ) {
    return this.clientsService.updateForUser(user.sub, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: { sub: string }, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.clientsService.deleteForUser(user.sub, id);
  }
}
