import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  tvgId?: string;
  group?: string;
  groupName?: string;
  catchup?: string;
  catchupDays?: number;
  catchupSource?: string;
  catchupCorrection?: number;
}

interface PlaylistResponse {
  channels: Channel[];
}

interface PairStartResponse {
  code: string;
  expiresAt: string;
  pollIntervalSec: number;
}

interface PairStatusResponse {
  status: 'PENDING' | 'PAIRED' | 'EXPIRED';
  deviceToken?: string;
}

interface WebOsRestoreResponse {
  restored: boolean;
  deviceToken?: string;
  deviceName?: string;
}

interface EpgProgramItem {
  title: string;
  start: string;
  end: string;
  description?: string;
}

interface EpgNowNextItem {
  channelId: string;
  channelTvgId?: string;
  channelLogo?: string;
  now?: EpgProgramItem;
  next?: EpgProgramItem;
}

interface EpgNowNextResponse {
  items: EpgNowNextItem[];
}

interface EpgDayItem {
  channelTvgId: string;
  programs: EpgProgramItem[];
}

interface EpgDayResponse {
  items: EpgDayItem[];
}

type ScreenView = 'pairing' | 'player';
type MenuFocusZone = 'categories' | 'channels';
type MenuView = 'channels' | 'epg';
type WebOsRuntimeMode = 'legacy' | 'balanced' | 'modern';
type RemoteAction =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'ENTER'
  | 'BACK'
  | 'EXIT'
  | 'MENU'
  | 'PLAY'
  | 'PAUSE'
  | 'PLAY_PAUSE'
  | 'STOP'
  | 'REWIND'
  | 'FAST_FORWARD'
  | 'CHANNEL_UP'
  | 'CHANNEL_DOWN'
  | 'MUTE'
  | 'RED'
  | 'GREEN'
  | 'YELLOW'
  | 'BLUE'
  | 'DIGIT'
  | 'NONE';

interface RemoteInput {
  action: RemoteAction;
  digit?: number;
}

interface WebOsRuntimeProfile {
  mode: WebOsRuntimeMode;
  webOsVersion?: number;
  cpuCores?: number;
  guideVisibleRows: number;
  epgPollIntervalMs: number;
  epgDayRefreshIntervalMs: number;
  uiAutoHideTimeoutMs: number;
  maxTimelineBlocksPerRow: number;
  simplifyGuideRows: boolean;
  skipDayGrid: boolean;
  disableBackdropFilter: boolean;
}

const DEVICE_TOKEN_KEY = 'iptv:webos:deviceToken';
const API_BASE_KEY = 'iptv:webos:apiBase';
const LAST_PLAYING_CHANNEL_ID_KEY = 'iptv:webos:lastPlayingChannelId';
const LAN_FALLBACK_API_BASE = import.meta.env.VITE_API_BASE_FALLBACK_URL ?? 'http://10.0.0.247:3000';
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? LAN_FALLBACK_API_BASE;
const OVERRIDE_WEB_ADMIN_BASE = import.meta.env.VITE_WEB_ADMIN_URL;
const REQUEST_TIMEOUT_MS = 9000;
const FETCH_ERROR_MESSAGE = 'failed to fetch';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const API_BASE_HINTS = [
  'http://10.0.0.245:3000',
  'http://10.0.0.247:3000',
  'http://10.0.0.246:3000',
  'http://192.168.100.4:3000',
  'http://10.0.2.2:3000',
  'http://172.17.0.1:3000'
];

const AUDIO_ONLY_DETECT_MS = 2500;
const CHANNEL_NUMBER_INPUT_TIMEOUT_MS = 1200;
const BASE_EPG_POLL_INTERVAL_MS = 60000;
const BASE_EPG_DAY_REFRESH_INTERVAL_MS = 120_000;
const BASE_UI_AUTO_HIDE_TIMEOUT_MS = 10000;
const PLAYER_INPUT_GUARD_MS = 900;
const NAVIGATION_REPEAT_THROTTLE_MS = 90;
const MENU_CHANNEL_ITEM_HEIGHT_PX = 62;
const BASE_GUIDE_VISIBLE_ROWS = 10;
const GUIDE_TIMELINE_STEP_MS = 30 * 60 * 1000;
const GUIDE_TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;
const GUIDE_NOW_SYNC_INTERVAL_MS = 30_000;
const MAX_DAY_PROGRAMS_PER_CHANNEL = 96;
const MAX_TIMELINE_BLOCKS_PER_ROW_HARD_LIMIT = 16;
const EPG_DAY_CHUNK_SIZE_LEGACY = 16;
const EPG_DAY_CHUNK_SIZE_BALANCED = 28;
const EPG_DAY_CHUNK_SIZE_MODERN = 40;
const WEBOS_VERSION_REGEX = /(?:web0s|webos)[^\d]{0,8}(\d+(?:\.\d+)?)/i;
const WEBOS_TV_YEAR_REGEX = /web0s\.tv[-/](\d{4})/i;

const parseRuntimeVersion = (rawValue: unknown): number | undefined => {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }
  if (typeof rawValue !== 'string') {
    return undefined;
  }
  const normalized = rawValue.trim().replace(/_/g, '.');
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
};

const requestWebOsRuntimeVersion = (): number | undefined => {
  if (typeof navigator === 'undefined') {
    return undefined;
  }

  const userAgent = navigator.userAgent || '';
  const direct = parseRuntimeVersion(userAgent.match(WEBOS_VERSION_REGEX)?.[1]);
  if (typeof direct === 'number') {
    return direct;
  }

  const yearMatch = userAgent.match(WEBOS_TV_YEAR_REGEX);
  const modelYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : Number.NaN;
  if (!Number.isFinite(modelYear)) {
    return undefined;
  }

  // Approximate major runtime bucket from marketing year when explicit runtime version is absent.
  if (modelYear <= 2018) {
    return 4;
  }
  if (modelYear <= 2021) {
    return 6;
  }
  return 22;
};

const requestHardwareConcurrency = (): number | undefined => {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const cores = Number((navigator as Navigator & { hardwareConcurrency?: unknown }).hardwareConcurrency);
  if (!Number.isFinite(cores) || cores <= 0) {
    return undefined;
  }
  return Math.floor(cores);
};

const resolveWebOsRuntimeProfile = (): WebOsRuntimeProfile => {
  const forcedModeRaw = String(import.meta.env.VITE_WEBOS_RUNTIME_MODE ?? '').trim().toLowerCase();
  const forcedMode: WebOsRuntimeMode | undefined =
    forcedModeRaw === 'legacy' || forcedModeRaw === 'balanced' || forcedModeRaw === 'modern'
      ? forcedModeRaw
      : undefined;
  const webOsVersion = requestWebOsRuntimeVersion();
  const cpuCores = requestHardwareConcurrency();

  let mode: WebOsRuntimeMode = 'balanced';
  if (typeof webOsVersion === 'number') {
    if (webOsVersion < 4) {
      mode = 'legacy';
    } else if (webOsVersion < 6) {
      mode = 'balanced';
    } else {
      mode = 'modern';
    }
  }

  if (typeof cpuCores === 'number') {
    if (cpuCores <= 2) {
      mode = 'legacy';
    } else if (cpuCores <= 4 && mode === 'modern') {
      mode = 'balanced';
    }
  }

  if (forcedMode) {
    mode = forcedMode;
  }

  if (mode === 'legacy') {
    return {
      mode,
      webOsVersion,
      cpuCores,
      guideVisibleRows: 6,
      epgPollIntervalMs: 90_000,
      epgDayRefreshIntervalMs: 240_000,
      uiAutoHideTimeoutMs: 16_000,
      maxTimelineBlocksPerRow: 4,
      simplifyGuideRows: true,
      skipDayGrid: true,
      disableBackdropFilter: true
    };
  }

  if (mode === 'modern') {
    return {
      mode,
      webOsVersion,
      cpuCores,
      guideVisibleRows: BASE_GUIDE_VISIBLE_ROWS,
      epgPollIntervalMs: BASE_EPG_POLL_INTERVAL_MS,
      epgDayRefreshIntervalMs: BASE_EPG_DAY_REFRESH_INTERVAL_MS,
      uiAutoHideTimeoutMs: BASE_UI_AUTO_HIDE_TIMEOUT_MS,
      maxTimelineBlocksPerRow: 12,
      simplifyGuideRows: false,
      skipDayGrid: false,
      disableBackdropFilter: false
    };
  }

  return {
    mode,
    webOsVersion,
    cpuCores,
    guideVisibleRows: 8,
    epgPollIntervalMs: 75_000,
    epgDayRefreshIntervalMs: 180_000,
    uiAutoHideTimeoutMs: 13_000,
    maxTimelineBlocksPerRow: 7,
    simplifyGuideRows: true,
    skipDayGrid: false,
    disableBackdropFilter: true
  };
};

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');
const getChannelGroupName = (channel: Channel): string => normalizeGroupName(channel.groupName ?? channel.group);
const normalizeTvgId = (value?: string): string => (value ?? '').trim().toLowerCase();
const normalizeGroupName = (value?: string): string => {
  const normalized = (value ?? '').trim();
  return normalized || 'Fara categorie';
};
const getLocalDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseProgramTimestamp = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
};

const resolveDisplayNowNext = (
  programs: EpgProgramItem[],
  timestamp: number
): { now?: EpgProgramItem; next?: EpgProgramItem; nowLabel: string } => {
  if (programs.length === 0) {
    return { now: undefined, next: undefined, nowLabel: 'Acum' };
  }

  const activeIndex = programs.findIndex((program) => {
    const start = parseProgramTimestamp(program.start);
    const end = parseProgramTimestamp(program.end);
    return typeof start === 'number' && typeof end === 'number' && timestamp >= start && timestamp < end;
  });
  if (activeIndex >= 0) {
    return {
      now: programs[activeIndex],
      next: programs[activeIndex + 1],
      nowLabel: 'Acum'
    };
  }

  const nextIndex = programs.findIndex((program) => {
    const start = parseProgramTimestamp(program.start);
    return typeof start === 'number' && start >= timestamp;
  });
  if (nextIndex >= 0) {
    return {
      now: programs[nextIndex],
      next: programs[nextIndex + 1],
      nowLabel: 'Program'
    };
  }

  return {
    now: programs[programs.length - 1],
    next: undefined,
    nowLabel: 'Ultimul'
  };
};

const getGuideWindowStart = (timestampMs: number): number => {
  return Math.max(timestampMs, Date.now());
};

const formatProgramTime = (value?: string): string => {
  if (!value) {
    return '--:--';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '--:--';
  }

  return parsed.toLocaleTimeString('ro-RO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
};

const formatTimeFromTimestamp = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleTimeString('ro-RO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

const formatProgramRange = (program?: EpgProgramItem): string => {
  if (!program) {
    return '--:-- - --:--';
  }
  return `${formatProgramTime(program.start)} - ${formatProgramTime(program.end)}`;
};

const wrapIndex = (next: number, length: number): number => {
  if (length <= 0) {
    return 0;
  }

  return (next % length + length) % length;
};

const trimTimelineBlocksAroundFocus = <T extends { startMs: number; endMs: number }>(
  blocks: T[],
  focusTimeMs: number,
  limit: number
): T[] => {
  if (blocks.length <= limit) {
    return blocks;
  }

  const focusIndex = blocks.findIndex((block) => focusTimeMs >= block.startMs && focusTimeMs < block.endMs);
  const anchorIndex =
    focusIndex >= 0 ? focusIndex : Math.max(blocks.findIndex((block) => block.startMs >= focusTimeMs), 0);
  const half = Math.floor(limit / 2);
  const maxStart = Math.max(blocks.length - limit, 0);
  const start = Math.min(Math.max(anchorIndex - half, 0), maxStart);
  return blocks.slice(start, start + limit);
};

const waitForUiYield = (): Promise<void> => {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
};

const getRemoteInput = (event: KeyboardEvent): RemoteInput => {
  const key = (event.key || '').toLowerCase();
  const code = event.keyCode;

  if (/^\d$/.test(key)) {
    return { action: 'DIGIT', digit: Number.parseInt(key, 10) };
  }
  if (code >= 48 && code <= 57) {
    return { action: 'DIGIT', digit: code - 48 };
  }
  if (code >= 96 && code <= 105) {
    return { action: 'DIGIT', digit: code - 96 };
  }

  if (key === 'arrowup' || code === 38) {
    return { action: 'UP' };
  }
  if (key === 'arrowdown' || code === 40) {
    return { action: 'DOWN' };
  }
  if (key === 'arrowleft' || code === 37) {
    return { action: 'LEFT' };
  }
  if (key === 'arrowright' || code === 39) {
    return { action: 'RIGHT' };
  }

  if (
    key === 'enter' ||
    key === 'ok' ||
    key === 'done' ||
    key === 'accept' ||
    key === 'go' ||
    key === 'submit' ||
    code === 13
  ) {
    return { action: 'ENTER' };
  }

  if (key === 'contextmenu' || key === 'menu' || code === 18) {
    return { action: 'MENU' };
  }

  if (key === 'channelup' || key === 'pageup' || code === 427 || code === 33) {
    return { action: 'CHANNEL_UP' };
  }
  if (key === 'channeldown' || key === 'pagedown' || code === 428 || code === 34) {
    return { action: 'CHANNEL_DOWN' };
  }

  if (key === 'mediaplaypause' || code === 179) {
    return { action: 'PLAY_PAUSE' };
  }
  if (key === 'mediaplay' || code === 415) {
    return { action: 'PLAY' };
  }
  if (key === 'mediapause' || code === 19) {
    return { action: 'PAUSE' };
  }
  if (key === 'mediastop' || code === 413) {
    return { action: 'STOP' };
  }
  if (key === 'mediarewind' || code === 412) {
    return { action: 'REWIND' };
  }
  if (key === 'mediafastforward' || code === 417) {
    return { action: 'FAST_FORWARD' };
  }

  if (key === 'audiomute' || code === 449) {
    return { action: 'MUTE' };
  }

  if (key === 'colorf0red' || code === 403) {
    return { action: 'RED' };
  }
  if (key === 'colorf1green' || code === 404) {
    return { action: 'GREEN' };
  }
  if (key === 'colorf2yellow' || code === 405) {
    return { action: 'YELLOW' };
  }
  if (key === 'colorf3blue' || code === 406) {
    return { action: 'BLUE' };
  }

  if (
    key === 'browserback' ||
    key === 'backspace' ||
    key === 'escape' ||
    key === 'back' ||
    key === 'goback' ||
    code === 8 ||
    code === 461
  ) {
    return { action: 'BACK' };
  }

  if (key === 'exit' || code === 10182 || code === 27) {
    return { action: 'EXIT' };
  }

  return { action: 'NONE' };
};

const getStorageValue = (key: string): string | undefined => {
  try {
    const value = localStorage.getItem(key);
    return value ?? undefined;
  } catch {
    return undefined;
  }
};

const setStorageValue = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
};

const removeStorageValue = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore storage failures
  }
};

const appendApiBaseCandidate = (list: string[], value?: string, allowLoopback = false): void => {
  if (!value) {
    return;
  }

  const normalized = normalizeBaseUrl(value);
  if (!normalized) {
    return;
  }

  try {
    const parsed = new URL(normalized);
    if (!allowLoopback && LOOPBACK_HOSTS.has(parsed.hostname)) {
      return;
    }

    const candidate = `${parsed.protocol}//${parsed.host}`;
    if (!list.includes(candidate)) {
      list.push(candidate);
    }
    return;
  } catch {
    if (!list.includes(normalized)) {
      list.push(normalized);
    }
  }
};

const buildApiBaseCandidates = (preferredBase?: string): string[] => {
  const candidates: string[] = [];

  appendApiBaseCandidate(candidates, preferredBase);
  appendApiBaseCandidate(candidates, getStorageValue(API_BASE_KEY));
  appendApiBaseCandidate(candidates, DEFAULT_API_BASE);
  appendApiBaseCandidate(candidates, LAN_FALLBACK_API_BASE);

  if (typeof window !== 'undefined') {
    const host = (window.location.hostname || '').trim();
    if (host && !LOOPBACK_HOSTS.has(host)) {
      appendApiBaseCandidate(candidates, `http://${host}:3000`);
    }
  }

  for (const hint of API_BASE_HINTS) {
    appendApiBaseCandidate(candidates, hint, true);
  }

  return candidates;
};

const getInitialApiBase = (): string => {
  const fallback = normalizeBaseUrl(DEFAULT_API_BASE);
  const candidates = buildApiBaseCandidates(DEFAULT_API_BASE);
  return candidates[0] ?? fallback;
};

const getWebAdminBase = (apiBase: string): string => {
  if (OVERRIDE_WEB_ADMIN_BASE) {
    return normalizeBaseUrl(OVERRIDE_WEB_ADMIN_BASE);
  }

  try {
    const parsed = new URL(apiBase);
    return `${parsed.protocol}//${parsed.hostname}:5175`;
  } catch {
    return 'http://localhost:5175';
  }
};

const MAC_ADDRESS_RE = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/;

interface WebOsServiceRequestOptions {
  method?: string;
  parameters?: Record<string, unknown>;
  onSuccess?: (response: unknown) => void;
  onFailure?: (error: unknown) => void;
}

type WebOsServiceRequestFn = (uri: string, options: WebOsServiceRequestOptions) => void;

const normalizeMacAddress = (raw: string): string => raw.trim().replace(/-/g, ':').toUpperCase();
const normalizeDeviceFingerprint = (raw?: string): string | undefined => {
  const normalized = (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  return normalized.length >= 6 ? normalized : undefined;
};

const findMacAddressInObject = (root: unknown): string | undefined => {
  const queue: unknown[] = [root];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (typeof current === 'string') {
      const match = current.match(MAC_ADDRESS_RE);
      if (match) {
        return normalizeMacAddress(match[0]);
      }
      continue;
    }

    if (typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    queue.push(...Object.values(current as Record<string, unknown>));
  }

  return undefined;
};

const getWebOsRequestFunction = (): WebOsServiceRequestFn | null => {
  const root = window as unknown as {
    webOS?: {
      service?: {
        request?: unknown;
      };
    };
  };
  const request = root.webOS?.service?.request;
  if (typeof request !== 'function') {
    return null;
  }
  return request as WebOsServiceRequestFn;
};

const requestWebOsMacAddress = async (): Promise<string | undefined> => {
  const request = getWebOsRequestFunction();
  if (!request) {
    return undefined;
  }

  const call = (uri: string, method?: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (value?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      const timeout = window.setTimeout(() => finish(undefined), 2500);
      try {
        request(uri, {
          ...(method ? { method } : {}),
          parameters: {},
          onSuccess: (response) => {
            window.clearTimeout(timeout);
            finish(findMacAddressInObject(response));
          },
          onFailure: () => {
            window.clearTimeout(timeout);
            finish(undefined);
          }
        });
      } catch {
        window.clearTimeout(timeout);
        finish(undefined);
      }
    });

  const direct = await call('luna://com.webos.service.connectionmanager/getinfo');
  if (direct) {
    return direct;
  }

  return call('luna://com.webos.service.connectionmanager', 'getinfo');
};

interface WebOsDevApi {
  LGUDID?: (params: {
    onSuccess?: (payload?: unknown) => void;
    onFailure?: (error?: unknown) => void;
  }) => void;
}

const extractFingerprintFromObject = (root: unknown): string | undefined => {
  const queue: unknown[] = [root];
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (typeof current === 'string') {
      const normalized = normalizeDeviceFingerprint(current);
      if (normalized) {
        return normalized;
      }
      continue;
    }

    if (typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    const keys = ['id', 'idValue', 'value', 'LGUDID', 'lgudid', 'deviceId'];
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string') {
        const normalized = normalizeDeviceFingerprint(value);
        if (normalized) {
          return normalized;
        }
      }
    }

    queue.push(...Object.values(record));
  }

  return undefined;
};

const requestWebOsLgUdidViaLuna = async (): Promise<string | undefined> => {
  const request = getWebOsRequestFunction();
  if (!request) {
    return undefined;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const timeout = window.setTimeout(() => finish(undefined), 3000);

    try {
      request('luna://com.webos.service.sm', {
        method: 'deviceid/getIDs',
        parameters: {
          idType: ['LGUDID']
        },
        onSuccess: (response) => {
          window.clearTimeout(timeout);
          finish(extractFingerprintFromObject(response));
        },
        onFailure: () => {
          window.clearTimeout(timeout);
          finish(undefined);
        }
      });
    } catch {
      window.clearTimeout(timeout);
      finish(undefined);
    }
  });
};

const requestWebOsLgUdidViaWebOsDev = async (): Promise<string | undefined> => {
  const root = window as unknown as {
    webOSDev?: WebOsDevApi;
  };
  const request = root.webOSDev?.LGUDID;
  if (typeof request !== 'function') {
    return undefined;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(undefined), 3000);

    try {
      request({
        onSuccess: (payload) => {
          window.clearTimeout(timeout);
          finish(extractFingerprintFromObject(payload));
        },
        onFailure: () => {
          window.clearTimeout(timeout);
          finish(undefined);
        }
      });
    } catch {
      window.clearTimeout(timeout);
      finish(undefined);
    }
  });
};

const requestWebOsDeviceFingerprint = async (): Promise<string | undefined> => {
  const fromWebOsDev = await requestWebOsLgUdidViaWebOsDev();
  if (fromWebOsDev) {
    return fromWebOsDev;
  }

  return requestWebOsLgUdidViaLuna();
};

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  let timeoutId: number | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(FETCH_ERROR_MESSAGE));
    }, REQUEST_TIMEOUT_MS);
  });

  const fetchPromise = (async () => {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      throw new Error(FETCH_ERROR_MESSAGE);
    }

    return (await response.json()) as T;
  })();

  try {
    return (await Promise.race([fetchPromise, timeoutPromise])) as T;
  } catch {
    throw new Error(FETCH_ERROR_MESSAGE);
  } finally {
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId);
    }
  }
};

export const WebOsApp: React.FC = () => {
  const runtimeProfile = useMemo(() => resolveWebOsRuntimeProfile(), []);
  const guideVisibleRows = runtimeProfile.guideVisibleRows;
  const shouldLoadDayGrid = !runtimeProfile.skipDayGrid;
  const timelineBlockLimit = Math.min(
    Math.max(runtimeProfile.maxTimelineBlocksPerRow, 1),
    MAX_TIMELINE_BLOCKS_PER_ROW_HARD_LIMIT
  );
  const navigationRepeatThrottleMs = runtimeProfile.mode === 'legacy' ? 140 : NAVIGATION_REPEAT_THROTTLE_MS;
  const [apiBase, setApiBase] = useState<string>(() => getInitialApiBase());
  const [view, setView] = useState<ScreenView>(() => (getStorageValue(DEVICE_TOKEN_KEY)?.trim() ? 'player' : 'pairing'));
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  const [, setPairingCode] = useState<string>();
  const [pairingUrl, setPairingUrl] = useState<string>();
  const [, setDeviceMacAddress] = useState<string>();
  const [, setDeviceFingerprint] = useState<string>();
  const [deviceToken, setDeviceToken] = useState<string>();
  const pairPollingRef = useRef<number>();
  const epgPollingRef = useRef<number>();
  const epgDayRefreshRef = useRef(0);
  const epgDayLoadRequestRef = useRef(0);
  const pairPollFailureCountRef = useRef(0);
  const startPairingRequestRef = useRef(0);
  const bootstrappedRef = useRef(false);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [epgNowNextByChannelId, setEpgNowNextByChannelId] = useState<Record<string, EpgNowNextItem>>({});
  const [epgDayByTvgId, setEpgDayByTvgId] = useState<Record<string, EpgProgramItem[]>>({});
  const [epgDayDate, setEpgDayDate] = useState(() => getLocalDateKey(new Date()));
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [guideSelectedIndex, setGuideSelectedIndex] = useState(0);
  const [guideListStartIndex, setGuideListStartIndex] = useState(0);
  const [guideFocusTimeMs, setGuideFocusTimeMs] = useState(() => Date.now());
  const [guideWindowStartMs, setGuideWindowStartMs] = useState(() => getGuideWindowStart(Date.now()));
  const [playingChannelId, setPlayingChannelId] = useState<string>();
  const [showChannelList, setShowChannelList] = useState(false);
  const [isUiVisible, setIsUiVisible] = useState(true);
  const [menuView, setMenuView] = useState<MenuView>('epg');
  const [, setMenuFocusZone] = useState<MenuFocusZone>('channels');
  const [channelNumberInput, setChannelNumberInput] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [audioOnlyWarning, setAudioOnlyWarning] = useState<string>();
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const channelNumberTimerRef = useRef<number>();
  const uiAutoHideTimerRef = useRef<number>();
  const playerInputGuardUntilRef = useRef(0);
  const lastNavigationEventAtRef = useRef(0);
  const backGuardPrimedRef = useRef(false);
  const channelNumberInputRef = useRef('');
  const channelButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const channelListRef = useRef<HTMLDivElement | null>(null);

  const categories = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const channel of channels) {
      const category = getChannelGroupName(channel);
      const existing = map.get(category);
      if (existing) {
        existing.push(channel);
      } else {
        map.set(category, [channel]);
      }
    }

    return Array.from(map.entries()).map(([name, items]) => ({
      name,
      channels: items
    }));
  }, [channels]);

  const selectedCategory = categories[selectedCategoryIndex] ?? categories[0];
  const categoryChannels = selectedCategory?.channels ?? [];

  const playingChannel = useMemo(
    () => channels.find((channel) => channel.id === playingChannelId),
    [channels, playingChannelId]
  );
  const epgByTvgId = useMemo(() => {
    const map = new Map<string, EpgNowNextItem>();
    for (const item of Object.values(epgNowNextByChannelId)) {
      const tvgId = typeof item.channelTvgId === 'string' ? item.channelTvgId.trim() : '';
      if (tvgId) {
        map.set(tvgId, item);
      }
    }
    return map;
  }, [epgNowNextByChannelId]);
  const getNowNextForChannel = useCallback(
    (channel?: Channel): EpgNowNextItem | undefined => {
      if (!channel) {
        return undefined;
      }

      const direct = epgNowNextByChannelId[channel.id];
      if (direct) {
        return direct;
      }

      const tvgId = typeof channel.tvgId === 'string' ? channel.tvgId.trim() : '';
      if (!tvgId) {
        return undefined;
      }

      return epgByTvgId.get(tvgId);
    },
    [epgByTvgId, epgNowNextByChannelId]
  );
  const playingChannelNowNext = useMemo(() => {
    return getNowNextForChannel(playingChannel);
  }, [getNowNextForChannel, playingChannel]);
  const getProgramsForChannel = useCallback(
    (channel?: Channel): EpgProgramItem[] => {
      if (!channel) {
        return [];
      }

      const nowNext = getNowNextForChannel(channel);
      const directTvgId = normalizeTvgId(channel.tvgId);
      const resolvedTvgId = directTvgId || normalizeTvgId(nowNext?.channelTvgId);
      const fromDayGrid = shouldLoadDayGrid && resolvedTvgId ? epgDayByTvgId[resolvedTvgId] : undefined;
      if (Array.isArray(fromDayGrid) && fromDayGrid.length > 0) {
        return fromDayGrid;
      }

      const fallback = [nowNext?.now, nowNext?.next].filter(Boolean) as EpgProgramItem[];
      if (!fallback.length) {
        return [];
      }

      return fallback
        .map((program) => ({
          title: program.title,
          start: program.start,
          end: program.end,
          description: program.description
        }))
        .sort((left, right) => {
          const leftStart = parseProgramTimestamp(left.start) ?? 0;
          const rightStart = parseProgramTimestamp(right.start) ?? 0;
          return leftStart - rightStart;
        });
    },
    [epgDayByTvgId, getNowNextForChannel, shouldLoadDayGrid]
  );
  const nowMs = Date.now();
  const playingChannelPrograms = useMemo(
    () => getProgramsForChannel(playingChannel),
    [getProgramsForChannel, playingChannel]
  );
  const playingProgramFallback = useMemo(
    () => resolveDisplayNowNext(playingChannelPrograms, nowMs),
    [nowMs, playingChannelPrograms]
  );
  const playingNowProgram = playingChannelNowNext?.now ?? playingProgramFallback.now;
  const playingNextProgram = playingChannelNowNext?.next ?? playingProgramFallback.next;
  const playingNowLabel = playingChannelNowNext?.now ? 'Acum' : playingProgramFallback.nowLabel;
  const guideWindowEndMs = guideWindowStartMs + GUIDE_TIMELINE_WINDOW_MS;
  const guideTickMarks = useMemo(() => {
    const ticks: Array<{ timeMs: number; leftPct: number; label: string }> = [];
    for (let timeMs = guideWindowStartMs; timeMs <= guideWindowEndMs; timeMs += GUIDE_TIMELINE_STEP_MS) {
      ticks.push({
        timeMs,
        leftPct: ((timeMs - guideWindowStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100,
        label: formatTimeFromTimestamp(timeMs)
      });
    }
    return ticks;
  }, [guideWindowEndMs, guideWindowStartMs]);
  const nowLinePct = ((nowMs - guideWindowStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100;
  const showNowLine = nowLinePct >= 0 && nowLinePct <= 100;
  const focusLinePct = Math.min(Math.max(((guideFocusTimeMs - guideWindowStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100, 0), 100);
  const selectedGuideChannel = channels[guideSelectedIndex];
  const guideWindowRange = useMemo(
    () => {
      const total = channels.length;
      if (total <= 0) {
        return { start: 0, end: 0 };
      }
      const maxStartIndex = Math.max(total - guideVisibleRows, 0);
      const safeStart = Math.min(Math.max(guideListStartIndex, 0), maxStartIndex);
      return {
        start: safeStart,
        end: Math.min(safeStart + guideVisibleRows, total)
      };
    },
    [channels.length, guideListStartIndex, guideVisibleRows]
  );
  const visibleGuideChannels = useMemo(
    () => channels.slice(guideWindowRange.start, guideWindowRange.end),
    [channels, guideWindowRange.end, guideWindowRange.start]
  );
  const playingChannelLogo = playingChannelNowNext?.channelLogo ?? playingChannel?.logo;
  const normalizedPlayingChannelLogo = typeof playingChannelLogo === 'string' ? playingChannelLogo.trim() : '';
  const shouldShowPlayingChannelLogo = normalizedPlayingChannelLogo.length > 0 && !logoLoadFailed;

  useEffect(() => {
    setLogoLoadFailed(false);
  }, [playingChannelLogo, playingChannelId]);

  useEffect(() => {
    if (!playingChannelId) {
      removeStorageValue(LAST_PLAYING_CHANNEL_ID_KEY);
      return;
    }
    setStorageValue(LAST_PLAYING_CHANNEL_ID_KEY, playingChannelId);
  }, [playingChannelId]);

  const clearPairPolling = useCallback(() => {
    if (pairPollingRef.current) {
      window.clearInterval(pairPollingRef.current);
      pairPollingRef.current = undefined;
    }
  }, []);

  const clearEpgPolling = useCallback(() => {
    if (epgPollingRef.current) {
      window.clearInterval(epgPollingRef.current);
      epgPollingRef.current = undefined;
    }
  }, []);

  const clearChannelNumberTimer = useCallback(() => {
    if (channelNumberTimerRef.current) {
      window.clearTimeout(channelNumberTimerRef.current);
      channelNumberTimerRef.current = undefined;
    }
  }, []);

  const clearUiAutoHideTimer = useCallback(() => {
    if (uiAutoHideTimerRef.current) {
      window.clearTimeout(uiAutoHideTimerRef.current);
      uiAutoHideTimerRef.current = undefined;
    }
  }, []);

  const scheduleUiAutoHide = useCallback(() => {
    clearUiAutoHideTimer();
    uiAutoHideTimerRef.current = window.setTimeout(() => {
      setIsUiVisible(false);
      setShowChannelList(false);
      setMenuView('epg');
      setMenuFocusZone('channels');
      clearChannelNumberTimer();
      channelNumberInputRef.current = '';
      setChannelNumberInput('');
    }, runtimeProfile.uiAutoHideTimeoutMs);
  }, [clearChannelNumberTimer, clearUiAutoHideTimer, runtimeProfile.uiAutoHideTimeoutMs]);

  const registerPlayerActivity = useCallback(() => {
    setIsUiVisible(true);
    if (showChannelList) {
      clearUiAutoHideTimer();
      return;
    }
    scheduleUiAutoHide();
  }, [clearUiAutoHideTimer, scheduleUiAutoHide, showChannelList]);

  const clearChannelNumberInput = useCallback(() => {
    clearChannelNumberTimer();
    channelNumberInputRef.current = '';
    setChannelNumberInput('');
  }, [clearChannelNumberTimer]);

  const playLiveChannelById = useCallback((channelId: string): void => {
    setAudioOnlyWarning(undefined);
    setPlayingChannelId(channelId);
  }, []);

  const openChannelList = useCallback(
    () => {
      registerPlayerActivity();
      setMenuView('epg');
      setMenuFocusZone('channels');
      setShowChannelList(true);
      const currentPlayingId = playingChannelId ?? channels[0]?.id;
      const guideIndex = currentPlayingId ? channels.findIndex((channel) => channel.id === currentPlayingId) : -1;
      const nextGuideIndex = guideIndex >= 0 ? guideIndex : 0;
      const nextGuideChannelId = channels[nextGuideIndex]?.id;
      if (nextGuideChannelId && categories.length > 0) {
        const matchedCategoryIndex = categories.findIndex((category) =>
          category.channels.some((channel) => channel.id === nextGuideChannelId)
        );
        if (matchedCategoryIndex >= 0) {
          setSelectedCategoryIndex(matchedCategoryIndex);
          const nextCategoryChannels = categories[matchedCategoryIndex]?.channels ?? [];
          const matchedChannelIndex = nextCategoryChannels.findIndex((channel) => channel.id === nextGuideChannelId);
          setSelectedIndex(matchedChannelIndex >= 0 ? matchedChannelIndex : 0);
        }
      }
      const maxStartIndex = Math.max(channels.length - guideVisibleRows, 0);
      const nextStartIndex = Math.min(Math.max(nextGuideIndex - 1, 0), maxStartIndex);
      const nowTime = Date.now();
      setGuideSelectedIndex(nextGuideIndex);
      setGuideListStartIndex(nextStartIndex);
      setGuideFocusTimeMs(nowTime);
      setGuideWindowStartMs(getGuideWindowStart(nowTime));
      window.requestAnimationFrame(() => {
        const listElement = channelListRef.current;
        if (listElement) {
          listElement.scrollTop = 0;
        }
      });
      clearChannelNumberInput();
    },
    [categories, channels, clearChannelNumberInput, guideVisibleRows, playingChannelId, registerPlayerActivity]
  );

  const closeChannelList = useCallback(() => {
    registerPlayerActivity();
    setShowChannelList(false);
    setMenuView('epg');
    setMenuFocusZone('channels');
    clearChannelNumberInput();
  }, [clearChannelNumberInput, registerPlayerActivity]);

  const stepGuideCategory = useCallback(
    (delta: number) => {
      if (!categories.length || !channels.length) {
        return;
      }

      const focusedChannelId = channels[guideSelectedIndex]?.id;
      const focusedCategoryIndex =
        focusedChannelId
          ? categories.findIndex((category) => category.channels.some((channel) => channel.id === focusedChannelId))
          : -1;
      const safeCategoryIndex = focusedCategoryIndex >= 0 ? focusedCategoryIndex : selectedCategoryIndex;
      const nextCategoryIndex = wrapIndex(safeCategoryIndex + delta, categories.length);
      const nextCategoryChannels = categories[nextCategoryIndex]?.channels ?? [];
      const nextChannel = nextCategoryChannels[0];
      if (!nextChannel) {
        return;
      }

      const nextGuideIndex = channels.findIndex((channel) => channel.id === nextChannel.id);
      if (nextGuideIndex < 0) {
        return;
      }

      setSelectedCategoryIndex(nextCategoryIndex);
      setSelectedIndex(0);
      setGuideSelectedIndex(nextGuideIndex);
      clearChannelNumberInput();
    },
    [categories, channels, clearChannelNumberInput, guideSelectedIndex, selectedCategoryIndex]
  );

  const stepChannelAndPlay = useCallback(
    (delta: number) => {
      if (!channels.length) {
        return;
      }

      const currentPlayingId = playingChannelId ?? channels[0].id;
      const currentIndex = channels.findIndex((channel) => channel.id === currentPlayingId);
      const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = wrapIndex(safeCurrentIndex + delta, channels.length);
      const nextChannel = channels[nextIndex];
      if (!nextChannel) {
        return;
      }

      playLiveChannelById(nextChannel.id);
      setGuideSelectedIndex(nextIndex);
    },
    [channels, playLiveChannelById, playingChannelId]
  );

  const commitChannelNumberSelection = useCallback(
    (rawValue?: string) => {
      const value = (rawValue ?? channelNumberInputRef.current).trim();
      if (!value) {
        return;
      }

      clearChannelNumberInput();

      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return;
      }
      if (!channels.length) {
        return;
      }
      if (parsed > channels.length) {
        setStatusMessage(`Canalul ${parsed} nu exista in playlist.`);
        return;
      }

      const index = parsed - 1;
      const channel = channels[index];
      if (!channel) {
        return;
      }

      setSelectedIndex(index);
      setGuideSelectedIndex(index);
      playLiveChannelById(channel.id);
      setShowChannelList(false);
      setStatusMessage(`Canal ${parsed}: ${channel.name}`);
    },
    [channels, clearChannelNumberInput, playLiveChannelById]
  );

  const pushChannelNumberDigit = useCallback(
    (digit: number) => {
      if (!Number.isFinite(digit) || digit < 0 || digit > 9) {
        return;
      }

      const nextInput = `${channelNumberInputRef.current}${digit}`.replace(/^0+(?=\d)/, '').slice(-3);
      if (!nextInput) {
        return;
      }

      channelNumberInputRef.current = nextInput;
      setChannelNumberInput(nextInput);
      clearChannelNumberTimer();
      channelNumberTimerRef.current = window.setTimeout(() => {
        commitChannelNumberSelection(nextInput);
      }, CHANNEL_NUMBER_INPUT_TIMEOUT_MS);
    },
    [clearChannelNumberTimer, commitChannelNumberSelection]
  );

  const playCurrentVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.play().catch(() => {
      setErrorMessage('Could not start stream on this channel.');
    });
  }, []);

  const togglePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.paused) {
      playCurrentVideo();
      return;
    }

    video.pause();
  }, [playCurrentVideo]);

  const probeStoredDeviceToken = useCallback(
    async (token: string): Promise<{ invalid: boolean; resolvedBase?: string }> => {
      const candidates = buildApiBaseCandidates(apiBase);

      for (const candidateBase of candidates) {
        try {
          const response = (await Promise.race([
            fetch(`${candidateBase}/device/profile`, {
              method: 'GET',
              headers: {
                'x-device-token': token
              }
            }),
            new Promise<Response>((_, reject) => {
              window.setTimeout(() => reject(new Error(FETCH_ERROR_MESSAGE)), REQUEST_TIMEOUT_MS);
            })
          ])) as Response;

          if (response.ok) {
            return {
              invalid: false,
              resolvedBase: candidateBase
            };
          }

          if (response.status === 401 || response.status === 403) {
            return { invalid: true };
          }
        } catch {
          // ignore probe failures and continue with next candidate
        }
      }

      return { invalid: false };
    },
    [apiBase]
  );

  const resolveWebOsDeviceIdentity = useCallback(
    async (): Promise<{ macAddress?: string; fingerprint?: string }> => {
      const [macAddress, fingerprint] = await Promise.all([
        requestWebOsMacAddress(),
        requestWebOsDeviceFingerprint()
      ]);

      const normalizedMac = macAddress ? normalizeMacAddress(macAddress) : undefined;
      const normalizedFingerprint = normalizeDeviceFingerprint(fingerprint);

      if (normalizedMac) {
        setDeviceMacAddress(normalizedMac);
      }
      if (normalizedFingerprint) {
        setDeviceFingerprint(normalizedFingerprint);
      }

      return {
        macAddress: normalizedMac,
        fingerprint: normalizedFingerprint
      };
    },
    []
  );

  const restoreTokenByIdentity = useCallback(
    async (identity: {
      macAddress?: string;
      fingerprint?: string;
    }): Promise<{ deviceToken?: string; deviceName?: string; resolvedBase?: string }> => {
      const normalizedMac = identity.macAddress?.trim();
      const normalizedFingerprint = normalizeDeviceFingerprint(identity.fingerprint);
      const candidates = buildApiBaseCandidates(apiBase);

      for (const candidateBase of candidates) {
        try {
          if (normalizedMac) {
            const macResponse = await fetchJson<WebOsRestoreResponse>(
              `${candidateBase}/devices/webos/restore-token?mac=${encodeURIComponent(normalizedMac)}`
            );
            if (
              macResponse.restored &&
              typeof macResponse.deviceToken === 'string' &&
              macResponse.deviceToken.trim()
            ) {
              return {
                deviceToken: macResponse.deviceToken.trim(),
                deviceName: macResponse.deviceName,
                resolvedBase: candidateBase
              };
            }
          }

          if (normalizedFingerprint) {
            const fingerprintResponse = await fetchJson<WebOsRestoreResponse>(
              `${candidateBase}/devices/restore-token?platform=webos&fingerprint=${encodeURIComponent(normalizedFingerprint)}`
            );
            if (
              fingerprintResponse.restored &&
              typeof fingerprintResponse.deviceToken === 'string' &&
              fingerprintResponse.deviceToken.trim()
            ) {
              return {
                deviceToken: fingerprintResponse.deviceToken.trim(),
                deviceName: fingerprintResponse.deviceName,
                resolvedBase: candidateBase
              };
            }
          }

          const legacyResponse = await fetchJson<WebOsRestoreResponse>(
            `${candidateBase}/devices/webos/restore-token`
          );
          if (
            legacyResponse.restored &&
            typeof legacyResponse.deviceToken === 'string' &&
            legacyResponse.deviceToken.trim()
          ) {
            return {
              deviceToken: legacyResponse.deviceToken.trim(),
              deviceName: legacyResponse.deviceName,
              resolvedBase: candidateBase
            };
          }

          // Backend responded but has no matching paired device.
          // Continue probing other API candidates before giving up.
          continue;
        } catch {
          // ignore restore failures and continue with next candidate
        }
      }

      return {};
    },
    [apiBase]
  );

  const loadNowNextForToken = useCallback(
    async (token: string): Promise<void> => {
      const normalizedToken = token.trim();
      if (!normalizedToken) {
        setEpgNowNextByChannelId({});
        return;
      }

      const candidates = buildApiBaseCandidates(apiBase);

      let response: EpgNowNextResponse | undefined;
      let usedBase = candidates[0];
      let lastError: unknown;

      for (const candidateBase of candidates) {
        try {
          response = await fetchJson<EpgNowNextResponse>(`${candidateBase}/device/epg/now-next`, {
            headers: {
              'x-device-token': normalizedToken
            }
          });
          usedBase = candidateBase;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw lastError instanceof Error ? lastError : new Error(FETCH_ERROR_MESSAGE);
      }

      if (usedBase !== apiBase) {
        setApiBase(usedBase);
        setStorageValue(API_BASE_KEY, usedBase);
      }

      const mapped: Record<string, EpgNowNextItem> = {};
      const items = Array.isArray(response.items) ? response.items : [];
      for (const item of items) {
        if (!item || typeof item.channelId !== 'string') {
          continue;
        }
        const channelId = item.channelId.trim();
        if (!channelId) {
          continue;
        }
        mapped[channelId] = item;
      }

      setEpgNowNextByChannelId(mapped);
    },
    [apiBase]
  );

  const loadDayGridForToken = useCallback(
    async (token: string, dayKey: string): Promise<void> => {
      const requestId = epgDayLoadRequestRef.current + 1;
      epgDayLoadRequestRef.current = requestId;
      const normalizedToken = token.trim();
      if (!normalizedToken) {
        setEpgDayByTvgId({});
        return;
      }

      const candidates = buildApiBaseCandidates(apiBase);

      let response: EpgDayResponse | undefined;
      let usedBase = candidates[0];
      let lastError: unknown;

      for (const candidateBase of candidates) {
        try {
          response = await fetchJson<EpgDayResponse>(
            `${candidateBase}/device/epg/day?date=${encodeURIComponent(dayKey)}`,
            {
              headers: {
                'x-device-token': normalizedToken
              }
            }
          );
          usedBase = candidateBase;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw lastError instanceof Error ? lastError : new Error(FETCH_ERROR_MESSAGE);
      }

      if (epgDayLoadRequestRef.current !== requestId) {
        return;
      }

      if (usedBase !== apiBase) {
        setApiBase(usedBase);
        setStorageValue(API_BASE_KEY, usedBase);
      }

      const items = Array.isArray(response.items) ? response.items : [];
      const chunkSize =
        runtimeProfile.mode === 'legacy'
          ? EPG_DAY_CHUNK_SIZE_LEGACY
          : runtimeProfile.mode === 'modern'
            ? EPG_DAY_CHUNK_SIZE_MODERN
            : EPG_DAY_CHUNK_SIZE_BALANCED;

      setEpgDayByTvgId({});
      setEpgDayDate(dayKey);
      epgDayRefreshRef.current = Date.now();

      for (let offset = 0; offset < items.length; offset += chunkSize) {
        if (epgDayLoadRequestRef.current !== requestId) {
          return;
        }

        const mappedChunk: Record<string, EpgProgramItem[]> = {};
        let hasMappedChunk = false;
        const chunkItems = items.slice(offset, offset + chunkSize);
        for (const item of chunkItems) {
          if (!item || typeof item.channelTvgId !== 'string') {
            continue;
          }
          const tvgId = normalizeTvgId(item.channelTvgId);
          if (!tvgId) {
            continue;
          }

          const programs = Array.isArray(item.programs) ? item.programs : [];
          const validPrograms = programs
            .filter((program) => {
              const start = parseProgramTimestamp(program?.start);
              const end = parseProgramTimestamp(program?.end);
              return Boolean(
                program && typeof program.title === 'string' && typeof start === 'number' && typeof end === 'number'
              );
            })
            .sort((left, right) => {
              const leftStart = parseProgramTimestamp(left.start) ?? 0;
              const rightStart = parseProgramTimestamp(right.start) ?? 0;
              return leftStart - rightStart;
            });

          if (validPrograms.length > 0) {
            mappedChunk[tvgId] = validPrograms.slice(0, MAX_DAY_PROGRAMS_PER_CHANNEL);
            hasMappedChunk = true;
          }
        }

        if (hasMappedChunk) {
          setEpgDayByTvgId((current) => ({
            ...current,
            ...mappedChunk
          }));
        }

        if (offset + chunkSize < items.length) {
          await waitForUiYield();
        }
      }
    },
    [apiBase, runtimeProfile.mode]
  );

  const loadPlaylist = useCallback(
    async (token: string) => {
      const candidates = buildApiBaseCandidates(apiBase);

      let response: PlaylistResponse | undefined;
      let usedBase = candidates[0];
      let lastError: unknown;

      for (const candidateBase of candidates) {
        try {
          response = await fetchJson<PlaylistResponse>(`${candidateBase}/device/playlist`, {
            headers: {
              'x-device-token': token
            }
          });
          usedBase = candidateBase;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw lastError instanceof Error ? lastError : new Error(FETCH_ERROR_MESSAGE);
      }

      const resolvedChannels = Array.isArray(response.channels) ? response.channels : [];
      const savedPlayingChannelId = getStorageValue(LAST_PLAYING_CHANNEL_ID_KEY)?.trim();
      const restoredPlayingChannelId =
        savedPlayingChannelId && resolvedChannels.some((channel) => channel.id === savedPlayingChannelId)
          ? savedPlayingChannelId
          : resolvedChannels[0]?.id;

      const groupedChannels = new Map<string, Channel[]>();
      for (const channel of resolvedChannels) {
        const categoryName = getChannelGroupName(channel);
        const existing = groupedChannels.get(categoryName);
        if (existing) {
          existing.push(channel);
        } else {
          groupedChannels.set(categoryName, [channel]);
        }
      }
      const groupedCategoryItems = Array.from(groupedChannels.values());
      let restoredCategoryIndex = 0;
      let restoredChannelIndex = 0;
      if (restoredPlayingChannelId) {
        for (let categoryIndex = 0; categoryIndex < groupedCategoryItems.length; categoryIndex += 1) {
          const channelIndex = groupedCategoryItems[categoryIndex].findIndex((channel) => channel.id === restoredPlayingChannelId);
          if (channelIndex >= 0) {
            restoredCategoryIndex = categoryIndex;
            restoredChannelIndex = channelIndex;
            break;
          }
        }
      }

      if (usedBase !== apiBase) {
        setApiBase(usedBase);
        setStorageValue(API_BASE_KEY, usedBase);
      }

      setStorageValue(DEVICE_TOKEN_KEY, token);
      setDeviceToken(token);
      setChannels(resolvedChannels);
      setEpgNowNextByChannelId({});
      setEpgDayByTvgId({});
      setEpgDayDate(getLocalDateKey(new Date()));
      setSelectedCategoryIndex(restoredCategoryIndex);
      setSelectedIndex(restoredChannelIndex);
      setGuideSelectedIndex(0);
      setGuideListStartIndex(0);
      setGuideFocusTimeMs(Date.now());
      setGuideWindowStartMs(getGuideWindowStart(Date.now()));
      setPlayingChannelId(restoredPlayingChannelId);
      setShowChannelList(false);
      setMenuView('epg');
      setMenuFocusZone('channels');
      setAudioOnlyWarning(undefined);
      clearChannelNumberInput();
      playerInputGuardUntilRef.current = Date.now() + PLAYER_INPUT_GUARD_MS;
      setView('player');
      setErrorMessage(undefined);
      setStatusMessage(
        resolvedChannels.length > 0
          ? `Connected. Loaded ${resolvedChannels.length} channels.`
          : 'Paired successfully. No channels configured yet.'
      );

      loadNowNextForToken(token).catch(() => {
        // EPG is optional; keep playback active even if now-next request fails.
      });
      if (shouldLoadDayGrid) {
        loadDayGridForToken(token, getLocalDateKey(new Date())).catch(() => {
          // Keep playback active if day EPG fails.
        });
      }
    },
    [apiBase, clearChannelNumberInput, loadDayGridForToken, loadNowNextForToken, shouldLoadDayGrid]
  );

  const startPairing = useCallback(async () => {
    const requestId = startPairingRequestRef.current + 1;
    startPairingRequestRef.current = requestId;
    clearPairPolling();
    clearEpgPolling();
    setView('pairing');
    setErrorMessage(undefined);
    setStatusMessage('Generating pairing code...');
    setPairingCode(undefined);
    setPairingUrl(undefined);
    setDeviceToken(undefined);
    setEpgNowNextByChannelId({});
    setEpgDayByTvgId({});
    setEpgDayDate(getLocalDateKey(new Date()));
    setGuideFocusTimeMs(Date.now());
    setGuideWindowStartMs(getGuideWindowStart(Date.now()));
    const identity = await resolveWebOsDeviceIdentity();
    const deviceName = identity.macAddress
      ? `LG webOS TV [${identity.macAddress}]`
      : identity.fingerprint
        ? `LG webOS TV [${identity.fingerprint}]`
        : 'LG webOS TV';

    const candidates = buildApiBaseCandidates(apiBase);

    let started: PairStartResponse | undefined;
    let usedBase = candidates[0];
    let lastError: unknown;

    for (const candidateBase of candidates) {
      try {
        started = await fetchJson<PairStartResponse>(`${candidateBase}/devices/pair/start`, {
          method: 'POST',
          body: JSON.stringify({
            deviceName,
            platform: 'webos'
          })
        });
        usedBase = candidateBase;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!started) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError ?? '');
      throw new Error(`${FETCH_ERROR_MESSAGE}. tried: ${candidates.join(' | ')}. last: ${detail}`);
    }

    if (usedBase !== apiBase) {
      setApiBase(usedBase);
      setStorageValue(API_BASE_KEY, usedBase);
    }

    if (startPairingRequestRef.current !== requestId) {
      return;
    }

    setPairingCode(started.code);
    setPairingUrl(`${getWebAdminBase(usedBase)}/?pairCode=${encodeURIComponent(started.code)}`);
    pairPollFailureCountRef.current = 0;
    setStatusMessage(
      identity.macAddress
        ? `Scan QR and confirm pair in web-admin. MAC: ${identity.macAddress}`
        : identity.fingerprint
          ? `Scan QR and confirm pair in web-admin. ID: ${identity.fingerprint}`
          : 'Scan QR and confirm pair in web-admin.'
    );

    const intervalMs = Math.max(started.pollIntervalSec || 3, 2) * 1000;
    pairPollingRef.current = window.setInterval(() => {
      if (startPairingRequestRef.current !== requestId) {
        return;
      }

      fetchJson<PairStatusResponse>(
        `${usedBase}/devices/pair/status?code=${encodeURIComponent(started.code)}`
      )
        .then((status) => {
          if (startPairingRequestRef.current !== requestId) {
            return;
          }

          pairPollFailureCountRef.current = 0;
          setErrorMessage(undefined);

          if (status.status === 'PAIRED' && status.deviceToken) {
            clearPairPolling();
            setPairingCode(undefined);
            setPairingUrl(undefined);
            setStatusMessage('Pairing confirmed. Loading channels...');
            loadPlaylist(status.deviceToken).catch((err: unknown) => {
              if (startPairingRequestRef.current !== requestId) {
                return;
              }
              removeStorageValue(DEVICE_TOKEN_KEY);
              setDeviceToken(undefined);
              setEpgNowNextByChannelId({});
              const message = err instanceof Error ? err.message : 'Failed to load playlist.';
              setErrorMessage(message);
              setStatusMessage('Playlist loading failed. Generating a new QR...');
              startPairing().catch((restartError: unknown) => {
                const restartMessage =
                  restartError instanceof Error ? restartError.message : FETCH_ERROR_MESSAGE;
                setErrorMessage(restartMessage);
              });
            });
            return;
          }

          if (status.status === 'EXPIRED') {
            clearPairPolling();
            setStatusMessage('Pair code expired. Generating a new QR...');
            startPairing().catch((restartError: unknown) => {
              if (startPairingRequestRef.current !== requestId) {
                return;
              }
              const restartMessage =
                restartError instanceof Error ? restartError.message : FETCH_ERROR_MESSAGE;
              setErrorMessage(restartMessage);
            });
          }
        })
        .catch((err: unknown) => {
          if (startPairingRequestRef.current !== requestId) {
            return;
          }

          pairPollFailureCountRef.current += 1;
          const failures = pairPollFailureCountRef.current;

          if (failures < 4) {
            setStatusMessage('Connection unstable. Retrying...');
            return;
          }

          clearPairPolling();
          const message = err instanceof Error ? err.message : FETCH_ERROR_MESSAGE;
          setErrorMessage(message);
          setStatusMessage('Connection lost. Generating a new QR...');
          startPairing().catch((restartError: unknown) => {
            if (startPairingRequestRef.current !== requestId) {
              return;
            }
            const restartMessage =
              restartError instanceof Error ? restartError.message : FETCH_ERROR_MESSAGE;
            setErrorMessage(restartMessage);
          });
        });
    }, intervalMs);
  }, [apiBase, clearEpgPolling, clearPairPolling, loadPlaylist, resolveWebOsDeviceIdentity]);

  useEffect(() => {
    if (!categories.length) {
      return;
    }

    if (selectedCategoryIndex >= categories.length) {
      setSelectedCategoryIndex(0);
    }
  }, [categories, selectedCategoryIndex]);

  useEffect(() => {
    if (!categoryChannels.length) {
      return;
    }

    if (selectedIndex >= categoryChannels.length) {
      setSelectedIndex(0);
    }
  }, [categoryChannels.length, selectedIndex]);

  useEffect(() => {
    if (!channels.length) {
      setGuideListStartIndex(0);
      return;
    }

    if (guideSelectedIndex >= channels.length) {
      setGuideSelectedIndex(0);
    }
  }, [channels.length, guideSelectedIndex]);

  useEffect(() => {
    if (!showChannelList || channels.length === 0) {
      return;
    }

    const maxStartIndex = Math.max(channels.length - guideVisibleRows, 0);
    setGuideListStartIndex((currentStart) => {
      let nextStart = Math.min(Math.max(currentStart, 0), maxStartIndex);
      if (guideSelectedIndex < nextStart) {
        nextStart = guideSelectedIndex;
      } else if (guideSelectedIndex >= nextStart + guideVisibleRows) {
        nextStart = guideSelectedIndex - guideVisibleRows + 1;
      }
      return Math.min(Math.max(nextStart, 0), maxStartIndex);
    });
  }, [channels.length, guideSelectedIndex, guideVisibleRows, showChannelList]);

  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;

    const restoreOrPair = async (): Promise<void> => {
      const storedToken = getStorageValue(DEVICE_TOKEN_KEY)?.trim();
      if (storedToken) {
        setStatusMessage('Restoring paired device...');

        const probe = await probeStoredDeviceToken(storedToken);
        if (probe.invalid) {
          removeStorageValue(DEVICE_TOKEN_KEY);
          setDeviceToken(undefined);
          setEpgNowNextByChannelId({});
          setView('pairing');
          await startPairing();
          return;
        }

        if (probe.resolvedBase && probe.resolvedBase !== apiBase) {
          setApiBase(probe.resolvedBase);
          setStorageValue(API_BASE_KEY, probe.resolvedBase);
        }

        try {
          await loadPlaylist(storedToken);
          return;
        } catch {
          // Keep the existing pairing on transient backend failures instead of forcing a new QR flow.
          setDeviceToken(storedToken);
          setView('player');
          setStatusMessage('Paired device restored. Waiting for backend...');
          setErrorMessage(undefined);
          window.setTimeout(() => {
            loadPlaylist(storedToken).catch(() => {
              // Keep current state; user remains paired and can retry without re-pairing.
            });
          }, 3000);
          return;
        }
      }

      const identity = await resolveWebOsDeviceIdentity();
      setStatusMessage('Restoring TV from database...');

      const restored = await restoreTokenByIdentity(identity);
      if (restored.resolvedBase && restored.resolvedBase !== apiBase) {
        setApiBase(restored.resolvedBase);
        setStorageValue(API_BASE_KEY, restored.resolvedBase);
      }

      if (restored.deviceToken) {
        try {
          await loadPlaylist(restored.deviceToken);
          setStatusMessage(
            restored.deviceName
              ? `Device restored: ${restored.deviceName}`
              : 'Device restored from database.'
          );
          return;
        } catch {
          // Continue to pairing flow if playlist load fails for restored token.
        }
      }

      setView('pairing');
      await startPairing();
    };

    restoreOrPair().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : FETCH_ERROR_MESSAGE;
      setErrorMessage(message);
    });
  }, [apiBase, loadPlaylist, probeStoredDeviceToken, resolveWebOsDeviceIdentity, restoreTokenByIdentity, startPairing]);

  useEffect(() => {
    if (view !== 'player' || !playingChannel || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    setAudioOnlyWarning(undefined);
    video.muted = isMuted;
    video.src = playingChannel.url;
    video.load();
    video.play().catch(() => {
      setErrorMessage('Could not start stream on this channel.');
    });

    const timer = window.setTimeout(() => {
      // If audio plays but videoWidth/videoHeight stay 0, the channel is usually audio-only
      // or encoded with unsupported video codec for this webOS browser.
      if (!video.paused && video.readyState >= 2 && (video.videoWidth === 0 || video.videoHeight === 0)) {
        setAudioOnlyWarning('Sunet fara imagine: codec video nesuportat pe acest TV pentru canalul selectat.');
      }
    }, AUDIO_ONLY_DETECT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isMuted, playingChannel, view]);

  useEffect(() => {
    if (view !== 'player' || !deviceToken) {
      clearEpgPolling();
      return;
    }

    loadNowNextForToken(deviceToken).catch(() => {
      // Keep existing UI state if EPG backend is temporarily unavailable.
    });

    epgPollingRef.current = window.setInterval(() => {
      loadNowNextForToken(deviceToken).catch(() => {
        // Keep existing UI state if EPG backend is temporarily unavailable.
      });
    }, runtimeProfile.epgPollIntervalMs);

    return () => {
      clearEpgPolling();
    };
  }, [clearEpgPolling, deviceToken, loadNowNextForToken, runtimeProfile.epgPollIntervalMs, view]);

  useEffect(() => {
    if (view !== 'player' || !deviceToken || !showChannelList || menuView !== 'epg' || !shouldLoadDayGrid) {
      return;
    }

    const refreshDay = (): void => {
      const targetDayKey = getLocalDateKey(new Date());
      const stale = Date.now() - epgDayRefreshRef.current > runtimeProfile.epgDayRefreshIntervalMs;
      if (targetDayKey !== epgDayDate || stale) {
        loadDayGridForToken(deviceToken, targetDayKey).catch(() => {
          // Keep the guide open even if a provider is temporarily unavailable.
        });
      }
    };

    refreshDay();
    const intervalId = window.setInterval(refreshDay, runtimeProfile.epgDayRefreshIntervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    deviceToken,
    epgDayDate,
    loadDayGridForToken,
    menuView,
    runtimeProfile.epgDayRefreshIntervalMs,
    shouldLoadDayGrid,
    showChannelList,
    view
  ]);

  useEffect(() => {
    if (view !== 'player' || !showChannelList) {
      return;
    }

    const syncGuideWindowWithNow = (): void => {
      const nowTime = Date.now();
      setGuideFocusTimeMs((current) => (current < nowTime ? nowTime : current));
      setGuideWindowStartMs((current) => (current < nowTime ? nowTime : current));
    };

    syncGuideWindowWithNow();
    const intervalId = window.setInterval(syncGuideWindowWithNow, GUIDE_NOW_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [showChannelList, view]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }
    videoRef.current.muted = isMuted;
  }, [isMuted]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const remoteInput = getRemoteInput(event);
      const { action, digit } = remoteInput;
      if (action === 'NONE') {
        return;
      }

      if (action === 'MENU') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }

      if (view === 'player') {
        if (
          Date.now() < playerInputGuardUntilRef.current &&
          (action === 'ENTER' ||
            action === 'MENU' ||
            action === 'RED' ||
            action === 'BLUE')
        ) {
          event.preventDefault();
          return;
        }

        registerPlayerActivity();

        const shouldThrottleNavigation =
          action === 'UP' ||
          action === 'DOWN' ||
          action === 'LEFT' ||
          action === 'RIGHT' ||
          action === 'REWIND' ||
          action === 'FAST_FORWARD' ||
          action === 'CHANNEL_UP' ||
          action === 'CHANNEL_DOWN';
        if (shouldThrottleNavigation && event.repeat) {
          const nowTime = Date.now();
          if (nowTime - lastNavigationEventAtRef.current < navigationRepeatThrottleMs) {
            event.preventDefault();
            return;
          }
          lastNavigationEventAtRef.current = nowTime;
        }

        if (action === 'DIGIT' && Number.isFinite(digit)) {
          event.preventDefault();
          pushChannelNumberDigit(digit as number);
          return;
        }

        if (
          !showChannelList &&
          (action === 'ENTER' ||
            action === 'MENU' ||
            action === 'RED' ||
            action === 'BLUE')
        ) {
          event.preventDefault();
          openChannelList();
          return;
        }

        if (action === 'MUTE') {
          event.preventDefault();
          setIsMuted((current) => !current);
          return;
        }

        if (action === 'PLAY') {
          event.preventDefault();
          playCurrentVideo();
          return;
        }

        if (action === 'PAUSE') {
          event.preventDefault();
          videoRef.current?.pause();
          return;
        }

        if (action === 'PLAY_PAUSE') {
          event.preventDefault();
          togglePlayPause();
          return;
        }

        if (action === 'STOP') {
          event.preventDefault();
          videoRef.current?.pause();
          openChannelList();
          return;
        }

        if (showChannelList && (action === 'REWIND' || action === 'CHANNEL_UP')) {
          event.preventDefault();
          if (channels.length > 0) {
            setGuideSelectedIndex((current) => wrapIndex(current - 1, channels.length));
            clearChannelNumberInput();
          }
          return;
        }

        if (showChannelList && (action === 'FAST_FORWARD' || action === 'CHANNEL_DOWN')) {
          event.preventDefault();
          if (channels.length > 0) {
            setGuideSelectedIndex((current) => wrapIndex(current + 1, channels.length));
            clearChannelNumberInput();
          }
          return;
        }

        if (action === 'REWIND' || action === 'CHANNEL_UP') {
          event.preventDefault();
          stepChannelAndPlay(-1);
          return;
        }

        if (action === 'FAST_FORWARD' || action === 'CHANNEL_DOWN') {
          event.preventDefault();
          stepChannelAndPlay(1);
          return;
        }

        if (action === 'BACK' || action === 'EXIT') {
          event.preventDefault();
          if (showChannelList) {
            closeChannelList();
          } else {
            setIsUiVisible(true);
            clearChannelNumberInput();
          }
          return;
        }

        const hasMenuChannels = channels.length > 0;
        if (!hasMenuChannels) {
          return;
        }

        if (!showChannelList && (action === 'UP' || action === 'LEFT')) {
          event.preventDefault();
          stepChannelAndPlay(-1);
          return;
        }

        if (!showChannelList && (action === 'DOWN' || action === 'RIGHT')) {
          event.preventDefault();
          stepChannelAndPlay(1);
          return;
        }

        if (!showChannelList) {
          return;
        }

        if (action === 'UP') {
          event.preventDefault();
          setGuideSelectedIndex((current) => wrapIndex(current - 1, channels.length));
          clearChannelNumberInput();
          return;
        }

        if (action === 'DOWN') {
          event.preventDefault();
          setGuideSelectedIndex((current) => wrapIndex(current + 1, channels.length));
          clearChannelNumberInput();
          return;
        }

        if (action === 'LEFT') {
          event.preventDefault();
          stepGuideCategory(-1);
          return;
        }

        if (action === 'RIGHT') {
          event.preventDefault();
          stepGuideCategory(1);
          return;
        }

        if (action === 'ENTER') {
          event.preventDefault();
          const guideChannel = channels[guideSelectedIndex];
          if (guideChannel) {
            playLiveChannelById(guideChannel.id);
            closeChannelList();
            clearChannelNumberInput();
            setStatusMessage(`Playing: ${guideChannel.name}`);
          }
          return;
        }

        return;
      }

      if (view === 'pairing' && (action === 'ENTER' || action === 'MENU' || action === 'RED')) {
        event.preventDefault();
        startPairing().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : FETCH_ERROR_MESSAGE;
          setErrorMessage(message);
        });
        return;
      }

      if (view === 'pairing' && (action === 'BACK' || action === 'EXIT')) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    channels,
    clearChannelNumberInput,
    closeChannelList,
    guideSelectedIndex,
    navigationRepeatThrottleMs,
    openChannelList,
    playCurrentVideo,
    playLiveChannelById,
    pushChannelNumberDigit,
    registerPlayerActivity,
    showChannelList,
    startPairing,
    stepGuideCategory,
    stepChannelAndPlay,
    togglePlayPause,
    view
  ]);

  useEffect(() => {
    if (view !== 'player') {
      return;
    }

    if (!backGuardPrimedRef.current) {
      try {
        window.history.pushState({ iptvGuard: true }, '', window.location.href);
      } catch {
        // ignore history API failures
      }
      backGuardPrimedRef.current = true;
    }

    const onPopState = (): void => {
      try {
        window.history.pushState({ iptvGuard: true }, '', window.location.href);
      } catch {
        // ignore history API failures
      }

      registerPlayerActivity();
      clearChannelNumberInput();
      if (showChannelList) {
        closeChannelList();
      } else {
        setIsUiVisible(true);
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [clearChannelNumberInput, closeChannelList, registerPlayerActivity, showChannelList, view]);

  useEffect(() => {
    if (view !== 'player') {
      clearUiAutoHideTimer();
      setIsUiVisible(true);
      return;
    }

    setIsUiVisible(true);
    if (showChannelList) {
      clearUiAutoHideTimer();
      return;
    }
    scheduleUiAutoHide();
  }, [clearUiAutoHideTimer, scheduleUiAutoHide, showChannelList, view]);

  useEffect(() => {
    if (!showChannelList) {
      clearChannelNumberInput();
    }
  }, [clearChannelNumberInput, showChannelList]);

  useEffect(() => {
    if (menuView === 'epg') {
      return;
    }
    const listItems = categoryChannels;
    if (!showChannelList || listItems.length === 0) {
      return;
    }

    const safeIndex = Math.min(Math.max(selectedIndex, 0), listItems.length - 1);
    const listElement = channelListRef.current;
    if (!listElement) {
      return;
    }

    const itemElement = channelButtonRefs.current[safeIndex];
    const itemHeight = MENU_CHANNEL_ITEM_HEIGHT_PX;
    const itemTop = itemElement ? itemElement.offsetTop : safeIndex * itemHeight;
    const itemBottom = itemElement ? itemElement.offsetTop + itemElement.offsetHeight : itemTop + itemHeight;
    const listTop = listElement.scrollTop;
    const listBottom = listTop + listElement.clientHeight;

    // Keep selection on the last visible row when moving down, and first visible row when moving up.
    if (itemBottom > listBottom) {
      listElement.scrollTop = itemBottom - listElement.clientHeight;
      return;
    }

    if (itemTop < listTop) {
      listElement.scrollTop = itemTop;
    }
  }, [categoryChannels, channels, guideSelectedIndex, menuView, selectedIndex, showChannelList]);

  useEffect(() => {
    return () => {
      clearChannelNumberInput();
      clearUiAutoHideTimer();
      clearPairPolling();
      clearEpgPolling();
    };
  }, [clearChannelNumberInput, clearEpgPolling, clearPairPolling, clearUiAutoHideTimer]);

  const pairingQrImageUrl = pairingUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(pairingUrl)}`
    : undefined;
  const guideGroupLabel = selectedGuideChannel?.groupName ?? selectedGuideChannel?.group ?? 'Toate canalele';
  const guideHeaderDateTime = new Date(nowMs).toLocaleString('ro-RO', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const playerClassName = [
    'player',
    `player--runtime-${runtimeProfile.mode}`,
    runtimeProfile.disableBackdropFilter ? 'player--no-backdrop' : '',
    isUiVisible && showChannelList ? 'is-menu-open' : ''
  ]
    .filter(Boolean)
    .join(' ');
  if (view !== 'player') {
    return (
      <div className="setup">
        <div className="setup__panel">
          <div className="pairing pairing--solo">
            {pairingQrImageUrl ? (
              <img src={pairingQrImageUrl} alt="Pairing QR code" />
            ) : (
              <p className="setup__hint">Generating QR code...</p>
            )}
            {errorMessage ? <p className="msg msg--error">{errorMessage}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={playerClassName}>
      <main className="screen">
        <video ref={videoRef} className="video" playsInline />

        {isUiVisible && !showChannelList ? (
          <>
            {channelNumberInput ? (
              <div className="screen__overlay screen__overlay--top">
                <div className="screen__chip-group">
                  <span className="screen__chip screen__chip--number">#{channelNumberInput}</span>
                </div>
              </div>
            ) : null}

            <div className="screen__overlay screen__overlay--bottom">
                <div className="screen__channel-info">
                  <div className="screen__channel-logo-slot">
                    {shouldShowPlayingChannelLogo ? (
                      <img
                        className="screen__channel-logo"
                        src={normalizedPlayingChannelLogo}
                        alt={`${playingChannel?.name ?? 'Channel'} logo`}
                        onError={() => setLogoLoadFailed(true)}
                      />
                    ) : (
                      <span className="screen__channel-logo-fallback-letter">
                        {(playingChannel?.name ?? '?').slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="screen__channel-info-meta">
                  <p className="screen__channel-info-name">
                    {playingChannel?.name || (channels.length === 0 ? 'Player activ' : 'Canal neselectat')}
                  </p>
                  <p className="screen__channel-epg-line">
                    <span className="screen__channel-epg-label">{playingNowLabel}</span>
                    <span className="screen__channel-epg-title">{playingNowProgram?.title ?? 'EPG indisponibil'}</span>
                    <span className="screen__channel-epg-time">{formatProgramRange(playingNowProgram)}</span>
                  </p>
                  <p className="screen__channel-epg-line">
                    <span className="screen__channel-epg-label">Urmeaza</span>
                    <span className="screen__channel-epg-title">{playingNextProgram?.title ?? '-'}</span>
                    <span className="screen__channel-epg-time">{formatProgramRange(playingNextProgram)}</span>
                  </p>
                </div>
              </div>
              <p className="screen__hint">
                {channels.length === 0
                  ? 'Pair activ. Seteaza playlist in admin.'
                  : 'CH+/CH- sau UP/DOWN canal | OK: ghid complet (canale + categorie + EPG) | PLAY/PAUSE control'}
              </p>
              {audioOnlyWarning ? <p className="msg msg--error screen__msg">{audioOnlyWarning}</p> : null}
              {errorMessage ? <p className="msg msg--error screen__msg">{errorMessage}</p> : null}
              {statusMessage ? <p className="msg msg--ok screen__msg">{statusMessage}</p> : null}
              {channels.length === 0 ? <p className="msg msg--ok screen__msg">Player pornit. Nu exista inca canale alocate.</p> : null}
            </div>
          </>
        ) : null}
      </main>

      {isUiVisible && showChannelList ? (
        <aside className={runtimeProfile.simplifyGuideRows ? 'epgx-guide epgx-guide--simplified' : 'epgx-guide'}>
          <header className="epgx-guide__header">
            <div className="epgx-guide__title-wrap">
              <h2 className="epgx-guide__title">TV Guide</h2>
              <p className="epgx-guide__meta">
                {guideHeaderDateTime} | {guideGroupLabel} | Focus {formatTimeFromTimestamp(guideFocusTimeMs)}
              </p>
            </div>
            <div className="epgx-guide__header-actions" aria-hidden="true">
              <span className="epgx-guide__action-chip">SEARCH</span>
              <span className="epgx-guide__action-chip">SETARI</span>
            </div>
          </header>

          <div className="epgx-guide__table-head">
            <span className="epgx-guide__table-col epgx-guide__table-col--nr">Nr</span>
            <span className="epgx-guide__table-col epgx-guide__table-col--logo">Logo</span>
            <span className="epgx-guide__table-col epgx-guide__table-col--name">Canal</span>
            <div className="epgx-guide__table-timeline">
              {guideTickMarks.map((tick) => (
                <span key={tick.timeMs} className="epgx-guide__tick" style={{ left: `${tick.leftPct}%` }}>
                  {tick.label}
                </span>
              ))}
              {showNowLine ? (
                <span className="epgx-guide__now-chip" style={{ left: `${nowLinePct}%` }}>
                  ACUM
                </span>
              ) : null}
              <span className="epgx-guide__focus-chip" style={{ left: `${focusLinePct}%` }}>
                {formatTimeFromTimestamp(guideFocusTimeMs)}
              </span>
            </div>
          </div>

          <div
            ref={(element) => {
              channelListRef.current = element;
            }}
            className="epgx-guide__rows"
          >
            {channels.length === 0 ? (
              <p className="epgx-guide__empty">Nu exista canale in playlist.</p>
            ) : (
              visibleGuideChannels.map((channel, localIndex) => {
                const index = guideWindowRange.start + localIndex;
                const isSelectedRow = index === guideSelectedIndex;
                const nowNext = getNowNextForChannel(channel);
                const rowLogo = nowNext?.channelLogo ?? channel.logo;
                const normalizedRowLogo = typeof rowLogo === 'string' ? rowLogo.trim() : '';
                const showRowLogo = normalizedRowLogo.length > 0;
                const programs = getProgramsForChannel(channel);
                const rowTimelineBlockLimit = isSelectedRow
                  ? timelineBlockLimit
                  : Math.max(2, Math.floor(timelineBlockLimit / 2));
                const rowTimelineFocusMs = isSelectedRow ? guideFocusTimeMs : nowMs;

                const timelineBlocks = trimTimelineBlocksAroundFocus(
                  programs
                    .map((program, programIndex) => {
                      const startMs = parseProgramTimestamp(program.start);
                      const endMs = parseProgramTimestamp(program.end);
                      if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs <= startMs) {
                        return undefined;
                      }
                      if (endMs <= guideWindowStartMs || startMs >= guideWindowEndMs) {
                        return undefined;
                      }

                      const clippedStartMs = Math.max(startMs, guideWindowStartMs);
                      const clippedEndMs = Math.min(endMs, guideWindowEndMs);
                      const leftPct = ((clippedStartMs - guideWindowStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100;
                      const widthPct = Math.max(((clippedEndMs - clippedStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100, 4);
                      return {
                        key: `${channel.id}:${programIndex}:${program.start}`,
                        program,
                        startMs,
                        endMs,
                        leftPct,
                        widthPct,
                        canArchive: false
                      };
                    })
                    .filter((item): item is NonNullable<typeof item> => Boolean(item)),
                  rowTimelineFocusMs,
                  rowTimelineBlockLimit
                );

                const focusMatch = timelineBlocks.find((block) => guideFocusTimeMs >= block.startMs && guideFocusTimeMs < block.endMs);
                const fallbackFocus = timelineBlocks.find((block) => block.startMs >= guideFocusTimeMs) ?? timelineBlocks[0];

                return (
                  <button
                    key={channel.id}
                    type="button"
                    ref={(element) => {
                      channelButtonRefs.current[index] = element;
                    }}
                    className={isSelectedRow ? 'epgx-guide__row is-active' : 'epgx-guide__row'}
                    onClick={() => {
                      setGuideSelectedIndex(index);
                      clearChannelNumberInput();
                    }}
                  >
                    <span className="epgx-guide__row-number">{index + 1}</span>
                    <span className="epgx-guide__row-logo-col">
                      <span className="epgx-guide__row-logo-slot">
                        {showRowLogo ? (
                          <img
                            className="epgx-guide__row-logo"
                            src={normalizedRowLogo}
                            alt={`${channel.name} logo`}
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <span className="epgx-guide__row-logo-fallback">
                            {(channel.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="epgx-guide__row-name">{channel.name || `Canal ${index + 1}`}</span>

                    <span className="epgx-guide__row-timeline">
                      {runtimeProfile.simplifyGuideRows
                        ? null
                        : guideTickMarks.slice(1, -1).map((tick) => (
                            <span
                              key={`${channel.id}:tick:${tick.timeMs}`}
                              className="epgx-guide__row-gridline"
                              style={{ left: `${tick.leftPct}%` }}
                            />
                          ))}
                      {showNowLine ? <span className="epgx-guide__row-now-line" style={{ left: `${nowLinePct}%` }} /> : null}
                      <span className="epgx-guide__row-focus-line" style={{ left: `${focusLinePct}%` }} />

                      {timelineBlocks.length > 0 ? (
                        timelineBlocks.map((block) => {
                          const isFocusedBlock =
                            isSelectedRow && (focusMatch ? focusMatch.key === block.key : fallbackFocus?.key === block.key);
                          return (
                            <span
                              key={block.key}
                              className={isFocusedBlock ? 'epgx-guide__program is-active' : 'epgx-guide__program'}
                              style={{ left: `${block.leftPct}%`, width: `${block.widthPct}%` }}
                            >
                              <span className="epgx-guide__program-title">{block.program.title}</span>
                              {runtimeProfile.simplifyGuideRows ? null : (
                                <span className="epgx-guide__program-time">{formatProgramRange(block.program)}</span>
                              )}
                            </span>
                          );
                        })
                      ) : (
                        <span
                          className={
                            isSelectedRow
                              ? 'epgx-guide__program epgx-guide__program--empty is-active'
                              : 'epgx-guide__program epgx-guide__program--empty'
                          }
                        >
                          <span className="epgx-guide__program-title">Fara EPG</span>
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
};


