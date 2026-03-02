type RequestLike = {
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: {
    remoteAddress?: string | null;
  };
};

const DEVICE_IP_TAG_RE = /\s*\[IP:\s*([^\]]+)\]\s*$/i;

export const normalizeClientIp = (raw?: string | null): string | null => {
  const value = (raw ?? '').trim();
  if (!value) {
    return null;
  }

  if (value.startsWith('::ffff:')) {
    return value.slice('::ffff:'.length);
  }

  return value;
};

export const getClientIpFromRequest = (request: RequestLike): string | null => {
  const forwarded = request.headers?.['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof forwardedValue === 'string' && forwardedValue.trim().length > 0) {
    const first = forwardedValue.split(',')[0]?.trim();
    const normalized = normalizeClientIp(first);
    if (normalized) {
      return normalized;
    }
  }

  const normalizedRequestIp = normalizeClientIp(request.ip);
  if (normalizedRequestIp) {
    return normalizedRequestIp;
  }

  return normalizeClientIp(request.socket?.remoteAddress);
};

export const withDeviceIpTag = (deviceName: string, ip?: string | null): string => {
  const baseName = deviceName.replace(DEVICE_IP_TAG_RE, '').trim();
  const normalizedIp = normalizeClientIp(ip);
  if (!normalizedIp) {
    return baseName;
  }

  return `${baseName} [IP: ${normalizedIp}]`;
};

export const extractDeviceIpTag = (deviceName: string): string | null => {
  const match = deviceName.match(DEVICE_IP_TAG_RE);
  return match?.[1]?.trim() ?? null;
};
