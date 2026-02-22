export type Platform = 'android-tv' | 'android' | 'tizen' | 'webos' | 'mag' | 'web' | 'unknown';

export interface ChannelDrmInfo {
  scheme: string;
  licenseUrl?: string;
}

export interface Channel {
  id: string;
  name: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  url: string;
  headers?: Record<string, string>;
  drm?: ChannelDrmInfo;
}
