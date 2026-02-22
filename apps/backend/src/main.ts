import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isPrivateHostname = (hostname: string): boolean => {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true
    })
  );

  const config = app.get(ConfigService);
  const corsOrigins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => stripTrailingSlash(origin));
  const corsOriginSet = new Set(corsOrigins);
  const allowPrivateLan =
    (config.get<string>('CORS_ALLOW_PRIVATE_LAN') ?? 'true').trim().toLowerCase() === 'true';

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || corsOriginSet.size === 0) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = stripTrailingSlash(origin);
      if (corsOriginSet.has(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      if (allowPrivateLan) {
        try {
          const hostname = new URL(normalizedOrigin).hostname;
          if (isPrivateHostname(hostname)) {
            callback(null, true);
            return;
          }
        } catch {
          // ignore parse errors and fall through to blocked CORS
        }
      }

      callback(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true
  });

  try {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('IPTV Backend API')
      .setDescription('MVP backend for IPTV Smart TV ecosystem')
      .setVersion('0.1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-device-token' }, 'device-token')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.warn(`Swagger disabled: ${message}`);
  }

  const port = Number(config.get('PORT') ?? 3000);
  await app.listen(port);
  console.log(`Backend running on http://localhost:${port}`);
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed', error);
  process.exit(1);
});
