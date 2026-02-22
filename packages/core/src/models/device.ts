import type { Platform } from './channel';

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  pairedAt?: string;
  lastSeenAt?: string;
}
