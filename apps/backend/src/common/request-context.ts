import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface JwtUser {
  sub: string;
  email: string;
}

export interface DeviceAuthContext {
  id: string;
  userId: string | null;
  name: string;
  platform: string;
}

export interface RequestWithContext extends Request {
  user?: JwtUser;
  device?: DeviceAuthContext;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): JwtUser => {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (!request.user) {
      throw new Error('Отсутствует контекст пользователя');
    }
    return request.user;
  }
);

export const CurrentDevice = createParamDecorator(
  (_: unknown, context: ExecutionContext): DeviceAuthContext => {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    if (!request.device) {
      throw new Error('Отсутствует контекст устройства');
    }
    return request.device;
  }
);
