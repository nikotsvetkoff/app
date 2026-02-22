import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root() {
    return {
      service: 'iptv-backend',
      status: 'ok',
      docs: '/docs',
      health: '/health'
    };
  }

  @Get('health')
  health() {
    return {
      status: 'ok'
    };
  }
}
