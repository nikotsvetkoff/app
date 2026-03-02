import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { JwtUser } from '../common/request-context';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(UsersService) private readonly usersService: UsersService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET')
    });
  }

  async validate(payload: JwtUser): Promise<JwtUser> {
    const userId = payload?.sub?.trim();
    if (!userId) {
      throw new UnauthorizedException('Invalid token');
    }

    const existing = await this.usersService.findById(userId);
    if (!existing) {
      throw new UnauthorizedException('Invalid token');
    }

    return payload;
  }
}
