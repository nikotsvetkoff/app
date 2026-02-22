import { BadRequestException } from '@nestjs/common';

const PRIVATE_NETWORK_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,
  /^\[::1\]$/,
  /^::1$/,
  /^metadata\.google\.internal$/i,
  /^169\.254\.169\.254$/,
  /\.local$/i
];

export const assertSafeHttpUrl = (rawUrl: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('Некорректный URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Разрешены только URL с протоколом http/https');
  }

  const host = parsed.hostname.trim();
  if (PRIVATE_NETWORK_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new BadRequestException('Хост URL запрещен по соображениям безопасности');
  }

  return parsed;
};
