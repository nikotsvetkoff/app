import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AvPlayAdapter } from '../platform/player-avplay';

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

interface RestoreTokenResponse {
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

interface PlaybackOverride {
  channelId: string;
  url: string;
  label: string;
}

type ScreenView = 'pairing' | 'player';
type MenuFocusZone = 'categories' | 'channels';
type MenuView = 'channels' | 'epg';
type TizenRuntimeMode = 'emulator' | 'legacy' | 'balanced' | 'modern';
type RemoteAction =
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'ENTER'
  | 'BACK'
  | 'EXIT'
  | 'MENU'
  | 'LIST'
  | 'GUIDE'
  | 'INFO'
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

interface TizenRuntimeProfile {
  mode: TizenRuntimeMode;
  platformVersion?: number;
  modelName?: string;
  isEmulator: boolean;
  supportsGuidePreviewRect: boolean;
  detachPlaybackInGuide: boolean;
  guideVisibleRows: number;
  epgPollIntervalMs: number;
  epgDayRefreshIntervalMs: number;
  uiAutoHideTimeoutMs: number;
  maxTimelineBlocksPerRow: number;
  simplifyGuideRows: boolean;
  skipDayGrid: boolean;
}

const DEVICE_TOKEN_KEY = 'iptv:tizen:deviceToken';
const API_BASE_KEY = 'iptv:tizen:apiBase';
const LAST_PLAYING_CHANNEL_ID_KEY = 'iptv:tizen:lastPlayingChannelId';
const LAST_PLAYING_CHANNEL_URL_KEY = 'iptv:tizen:lastPlayingChannelUrl';
const LAST_PLAYING_CHANNEL_TVG_ID_KEY = 'iptv:tizen:lastPlayingChannelTvgId';
const LAST_PLAYING_CHANNEL_NAME_KEY = 'iptv:tizen:lastPlayingChannelName';
const LAN_FALLBACK_API_BASE = import.meta.env.VITE_API_BASE_FALLBACK_URL ?? 'http://192.168.100.4:3000';
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? LAN_FALLBACK_API_BASE;
const OVERRIDE_WEB_ADMIN_BASE = import.meta.env.VITE_WEB_ADMIN_URL;
const REQUEST_TIMEOUT_MS = 9000;
const FETCH_ERROR_MESSAGE = 'failed to fetch';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const TIZEN_PLATFORM_VERSION_CAPABILITY = 'http://tizen.org/feature/platform.version';
const TIZEN_UA_VERSION_REGEX = /tizen[/\s]([0-9.]+)/i;
const API_BASE_HINTS = [
  'http://127.0.0.1:3000',
  'http://10.0.2.2:3000',
  'http://172.17.0.1:3000',
  'http://172.20.0.1:3000',
  'http://192.168.56.1:3000',
  'http://192.168.100.4:3000',
  'http://10.0.0.246:3000'
];

const CHANNEL_NUMBER_INPUT_TIMEOUT_MS = 1200;
const BASE_EPG_POLL_INTERVAL_MS = 60000;
const BASE_UI_AUTO_HIDE_TIMEOUT_MS = 10000;
const CHANNEL_INFO_OVERLAY_TIMEOUT_MS = 5000;
const BASE_EPG_DAY_REFRESH_INTERVAL_MS = 120000;
const PLAYER_INPUT_GUARD_MS = 900;
const MENU_CHANNEL_ITEM_HEIGHT_PX = 62;
const GUIDE_CHANNEL_ROW_HEIGHT_PX = 104;
const BASE_GUIDE_VISIBLE_ROWS = 10;
const TIZEN_MENU_VISIBLE_ITEMS = 7;
const GUIDE_TIMELINE_STEP_MS = 30 * 60 * 1000;
const GUIDE_TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;
const FORCE_EMULATOR_EPG_INFO_STYLE = false;
const FORCE_LIST_ONLY_MODE_ON_EMULATOR = true;
const DEBUG_REMOTE_OK_KEY = false;
const OPEN_MENU_ENTER_GUARD_MS = 1200;
const MENU_PREVIEW_WIDTH_RATIO = 0.34;
const MENU_PREVIEW_MAX_WIDTH_PX = 760;
const MENU_PREVIEW_MIN_WIDTH_PX = 320;
const MENU_PREVIEW_TOP_RATIO = 0.12;
const MENU_PREVIEW_SIDE_RATIO = 0.02;

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');
const getChannelGroupName = (channel: Channel): string => normalizeGroupName(channel.groupName ?? channel.group);
const normalizeTvgId = (value?: string): string => (value ?? '').trim().toLowerCase();
const normalizeChannelNameForRestore = (value?: string): string =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
const normalizeGroupName = (value?: string): string => {
  const normalized = (value ?? '').trim();
  return normalized || 'Fara categorie';
};

const resolveRestoredChannelId = (
  channels: Channel[],
  savedId?: string,
  savedUrl?: string,
  savedTvgId?: string,
  savedName?: string
): string | undefined => {
  if (channels.length === 0) {
    return undefined;
  }

  const normalizedSavedId = (savedId ?? '').trim();
  if (normalizedSavedId) {
    const byId = channels.find((channel) => channel.id === normalizedSavedId);
    if (byId) {
      return byId.id;
    }
  }

  const normalizedSavedUrl = (savedUrl ?? '').trim();
  if (normalizedSavedUrl) {
    const byUrl = channels.find((channel) => channel.url.trim() === normalizedSavedUrl);
    if (byUrl) {
      return byUrl.id;
    }
  }

  const normalizedSavedTvgId = normalizeTvgId(savedTvgId);
  if (normalizedSavedTvgId) {
    const byTvgId = channels.find((channel) => normalizeTvgId(channel.tvgId) === normalizedSavedTvgId);
    if (byTvgId) {
      return byTvgId.id;
    }
  }

  const normalizedSavedName = normalizeChannelNameForRestore(savedName);
  if (normalizedSavedName) {
    const byName = channels.find((channel) => normalizeChannelNameForRestore(channel.name) === normalizedSavedName);
    if (byName) {
      return byName.id;
    }
  }

  return channels[0]?.id;
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

const findProgramAtTime = (programs: EpgProgramItem[], timestamp: number): EpgProgramItem | undefined => {
  for (const program of programs) {
    const start = parseProgramTimestamp(program.start);
    const end = parseProgramTimestamp(program.end);
    if (typeof start !== 'number' || typeof end !== 'number') {
      continue;
    }
    if (timestamp >= start && timestamp < end) {
      return program;
    }
  }
  return undefined;
};

const findNextProgramAtTime = (programs: EpgProgramItem[], timestamp: number): EpgProgramItem | undefined => {
  for (const program of programs) {
    const start = parseProgramTimestamp(program.start);
    if (typeof start !== 'number') {
      continue;
    }
    if (start >= timestamp) {
      return program;
    }
  }
  return undefined;
};

const findEveningProgramAtTime = (programs: EpgProgramItem[], timestamp: number): EpgProgramItem | undefined => {
  const baseDate = new Date(timestamp);
  const eveningStart = new Date(baseDate);
  eveningStart.setHours(20, 0, 0, 0);
  const eveningEnd = new Date(baseDate);
  eveningEnd.setHours(23, 59, 59, 999);
  const eveningStartMs = eveningStart.getTime();
  const eveningEndMs = eveningEnd.getTime();

  for (const program of programs) {
    const start = parseProgramTimestamp(program.start);
    if (typeof start !== 'number') {
      continue;
    }
    if (start >= eveningStartMs && start <= eveningEndMs) {
      return program;
    }
  }

  return findNextProgramAtTime(programs, timestamp) ?? programs[programs.length - 1];
};

const findGuideProgramAtTime = (programs: EpgProgramItem[], timestamp: number): EpgProgramItem | undefined => {
  return (
    findProgramAtTime(programs, timestamp) ??
    findNextProgramAtTime(programs, timestamp) ??
    programs[programs.length - 1]
  );
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
  return Math.floor(timestampMs / GUIDE_TIMELINE_STEP_MS) * GUIDE_TIMELINE_STEP_MS;
};

const getViewportSize = (): { width: number; height: number } => {
  const screenWidth = Number(screen?.width);
  const screenHeight = Number(screen?.height);
  const hasScreenSize = Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0;
  const width = Math.max(
    1,
    Math.floor((hasScreenSize ? screenWidth : undefined) || window.innerWidth || document.documentElement?.clientWidth || 1920)
  );
  const height = Math.max(
    1,
    Math.floor((hasScreenSize ? screenHeight : undefined) || window.innerHeight || document.documentElement?.clientHeight || 1080)
  );
  return { width, height };
};

const getMenuPreviewRect = (): { x: number; y: number; width: number; height: number } => {
  const { width: viewportWidth, height: viewportHeight } = getViewportSize();
  const sideInset = Math.max(20, Math.round(viewportWidth * MENU_PREVIEW_SIDE_RATIO));
  const topInset = Math.max(72, Math.round(viewportHeight * MENU_PREVIEW_TOP_RATIO));
  const maxAllowedWidth = Math.max(1, viewportWidth - sideInset * 2);
  const baseWidth = Math.round(viewportWidth * MENU_PREVIEW_WIDTH_RATIO);
  const width = Math.max(
    1,
    Math.min(maxAllowedWidth, Math.max(MENU_PREVIEW_MIN_WIDTH_PX, Math.min(MENU_PREVIEW_MAX_WIDTH_PX, baseWidth)))
  );
  const baseHeight = Math.max(1, Math.round((width * 9) / 16));
  const maxAllowedHeight = Math.max(1, viewportHeight - topInset - sideInset);
  const height = Math.max(1, Math.min(maxAllowedHeight, baseHeight));
  const x = Math.max(0, viewportWidth - width - sideInset);
  const y = Math.max(0, Math.min(topInset, viewportHeight - height));
  return { x, y, width, height };
};

const toEpochSeconds = (timestampMs: number): string => String(Math.floor(timestampMs / 1000));
const resolveArchiveDays = (channel?: Channel): number => {
  if (!channel) {
    return 0;
  }
  if (typeof channel.catchupDays === 'number' && Number.isFinite(channel.catchupDays) && channel.catchupDays > 0) {
    return Math.floor(channel.catchupDays);
  }
  if ((channel.catchupSource ?? '').trim() || (channel.catchup ?? '').trim()) {
    return 14;
  }
  return 0;
};

const buildArchiveUrl = (channel: Channel, program: EpgProgramItem): string | undefined => {
  const rawStartMs = parseProgramTimestamp(program.start);
  const rawEndMs = parseProgramTimestamp(program.end);
  if (typeof rawStartMs !== 'number' || typeof rawEndMs !== 'number' || rawEndMs <= rawStartMs) {
    return undefined;
  }

  const correctionHours =
    typeof channel.catchupCorrection === 'number' && Number.isFinite(channel.catchupCorrection)
      ? channel.catchupCorrection
      : 0;
  const correctionMs = Math.round(correctionHours * 60 * 60 * 1000);
  const startMs = rawStartMs + correctionMs;
  const endMs = rawEndMs + correctionMs;
  const durationSeconds = Math.max(60, Math.floor((rawEndMs - rawStartMs) / 1000));
  const startEpoch = toEpochSeconds(startMs);
  const endEpoch = toEpochSeconds(endMs);
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const replacements: Array<[string, string]> = [
    ['{start}', startEpoch],
    ['${start}', startEpoch],
    ['{end}', endEpoch],
    ['${end}', endEpoch],
    ['{duration}', String(durationSeconds)],
    ['${duration}', String(durationSeconds)],
    ['{utc}', startEpoch],
    ['${utc}', startEpoch],
    ['{lutc}', startEpoch],
    ['${lutc}', startEpoch],
    ['{start_iso}', startIso],
    ['${start_iso}', startIso],
    ['{end_iso}', endIso],
    ['${end_iso}', endIso]
  ];

  const template = (channel.catchupSource ?? '').trim();
  if (template) {
    let resolvedTemplate = template;
    for (const [token, value] of replacements) {
      resolvedTemplate = resolvedTemplate.split(token).join(value);
    }
    try {
      return new URL(resolvedTemplate, channel.url).toString();
    } catch {
      return resolvedTemplate;
    }
  }

  try {
    const parsed = new URL(channel.url);
    parsed.searchParams.set('utc', startEpoch);
    parsed.searchParams.set('lutc', startEpoch);
    parsed.searchParams.set('duration', String(durationSeconds));
    return parsed.toString();
  } catch {
    return undefined;
  }
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

const formatTimeFromTimestamp12h = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });

const inferProgramGenre = (program?: EpgProgramItem): { label: string; icon: string } => {
  const title = (program?.title ?? '').toLowerCase();
  const description = (program?.description ?? '').toLowerCase();
  const haystack = `${title} ${description}`;

  if (/(sport|fotbal|football|tenis|tennis|hochei|hockey|nba|nfl|liga)/.test(haystack)) {
    return { label: 'Sport', icon: 'SP' };
  }
  if (/(news|stiri|jurnal|breaking|reportaj|actualitati)/.test(haystack)) {
    return { label: 'Stiri', icon: 'ST' };
  }
  if (/(film|movie|cinema|thriller|drama|comedy|comedie|documentar)/.test(haystack)) {
    return { label: 'Film', icon: 'FL' };
  }
  if (/(serial|series|episode|episod|show)/.test(haystack)) {
    return { label: 'Serial', icon: 'SR' };
  }

  return { label: 'General', icon: 'GN' };
};

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

const toLowerSafe = (value: unknown): string => String(value ?? '').toLowerCase();

const getRemoteInput = (event: KeyboardEvent): RemoteInput => {
  const key = toLowerSafe((event as KeyboardEvent & { key?: unknown }).key);
  const codeName = toLowerSafe((event as KeyboardEvent & { code?: unknown }).code);
  const legacyKeyIdentifier = toLowerSafe((event as KeyboardEvent & { keyIdentifier?: unknown }).keyIdentifier);
  const keyHints = `${key} ${codeName} ${legacyKeyIdentifier}`.trim();
  const rawCode = Number(
    (event as KeyboardEvent & { keyCode?: unknown }).keyCode ??
      (event as KeyboardEvent & { which?: unknown }).which ??
      0
  );
  const code = Number.isFinite(rawCode) ? rawCode : 0;

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
    codeName === 'enter' ||
    codeName === 'numpadenter' ||
    codeName === 'select' ||
    legacyKeyIdentifier === 'enter' ||
    legacyKeyIdentifier === 'select' ||
    legacyKeyIdentifier === 'u+000d' ||
    key.includes('enter') ||
    key.includes('select') ||
    key === 'enter' ||
    key === 'select' ||
    key === 'center' ||
    key === 'navienter' ||
    key === 'panelenter' ||
    key === 'ok' ||
    key === 'done' ||
    key === 'accept' ||
    key === 'go' ||
    key === 'submit' ||
    code === 13 ||
    code === 10013 ||
    code === 29443 ||
    code === 29460 ||
    code === 65376 ||
    code === 16777221
  ) {
    return { action: 'ENTER' };
  }

  if (
    key === 'list' ||
    key === 'channellist' ||
    key === 'livetv' ||
    key === 'tvlist' ||
    key === 'channels' ||
    key === 'previouschannel' ||
    keyHints.includes('channellist')
  ) {
    return { action: 'LIST' };
  }
  if (code === 10073 || code === 170 || code === 10190) {
    return { action: 'LIST' };
  }
  if (key === 'guide' || key === 'tvguide' || key === 'mediaguide' || key === 'epg' || code === 458 || code === 10131) {
    return { action: 'GUIDE' };
  }
  if (key === 'info' || code === 457) {
    return { action: 'INFO' };
  }
  if (key === 'contextmenu' || key === 'menu' || code === 18) {
    return { action: 'MENU' };
  }

  if (
    key === 'channelup' ||
    key === 'mediachannelup' ||
    key === 'chup' ||
    key === 'pageup' ||
    key === 'mediatracknext' ||
    key === 'tracknext' ||
    codeName === 'channelup' ||
    codeName === 'mediachannelup' ||
    keyHints.includes('channelup') ||
    keyHints.includes('ch+') ||
    code === 427 ||
    code === 33 ||
    code === 10233
  ) {
    return { action: 'CHANNEL_UP' };
  }
  if (
    key === 'channeldown' ||
    key === 'mediachanneldown' ||
    key === 'chdown' ||
    key === 'pagedown' ||
    key === 'mediatrackprevious' ||
    key === 'trackprevious' ||
    codeName === 'channeldown' ||
    codeName === 'mediachanneldown' ||
    keyHints.includes('channeldown') ||
    keyHints.includes('ch-') ||
    code === 428 ||
    code === 34 ||
    code === 10232
  ) {
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
    code === 461 ||
    code === 10009
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

const MAC_ADDRESS_RE = /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/i;

const normalizeMacAddress = (value?: string): string =>
  (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/-/g, ':');

const sanitizeMacAddress = (value?: string): string | undefined => {
  const normalized = normalizeMacAddress(value);
  if (!normalized) {
    return undefined;
  }

  const compact = normalized.replace(/[^0-9A-F]/g, '');
  if (compact.length !== 12) {
    return undefined;
  }

  const pairs = compact.match(/.{1,2}/g);
  if (!pairs) {
    return undefined;
  }
  return pairs.join(':');
};

const normalizeFingerprint = (value?: string): string =>
  (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');

const sanitizeFingerprint = (value?: string): string | undefined => {
  const normalized = normalizeFingerprint(value);
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
      const direct = sanitizeMacAddress(current);
      if (direct) {
        return direct;
      }
      const matched = current.match(MAC_ADDRESS_RE)?.[0];
      const fromMatch = sanitizeMacAddress(matched);
      if (fromMatch) {
        return fromMatch;
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

const buildDeviceNameWithIdentity = (baseName: string, macAddress?: string, fingerprint?: string): string => {
  const compactBase = (baseName ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  const normalizedBase = compactBase || 'Samsung Tizen TV';
  const normalizedFingerprint = sanitizeFingerprint(fingerprint);
  const normalizedMac = sanitizeMacAddress(macAddress);

  if (!normalizedFingerprint && !normalizedMac) {
    return normalizedBase.slice(0, 64);
  }

  let suffixParts: string[] = [];
  if (normalizedFingerprint) {
    suffixParts.push(`[${normalizedFingerprint}]`);
  }
  if (normalizedMac) {
    suffixParts.push(`[${normalizedMac}]`);
  }
  let suffix = ` ${suffixParts.join(' ')}`;
  if (suffix.length > 64 && normalizedFingerprint) {
    suffixParts = [`[${normalizedFingerprint}]`];
    suffix = ` ${suffixParts.join(' ')}`;
  }
  if (suffix.length > 64) {
    const compactTag = (normalizedFingerprint ?? normalizedMac ?? '').slice(0, 60);
    suffix = compactTag ? ` [${compactTag}]` : '';
  }
  const allowedBaseLength = Math.max(0, 64 - suffix.length);
  return `${normalizedBase.slice(0, allowedBaseLength)}${suffix}`;
};

const requestTizenMacAddress = async (): Promise<string | undefined> => {
  const tizenWindow = window as Window & {
    webapis?: {
      network?: {
        getMac?: () => string;
        getMAC?: () => string;
        getMacAddress?: () => string;
        getMacAddr?: () => string;
      };
    };
    tizen?: {
      systeminfo?: {
        getPropertyValue?: (
          property: string,
          successCallback: (info: unknown) => void,
          errorCallback?: (error: unknown) => void
        ) => void;
      };
    };
  };

  const network = tizenWindow.webapis?.network;
  const directCandidates: Array<unknown> = [];
  try {
    directCandidates.push(network?.getMac?.());
  } catch {
    // ignore runtime capability errors
  }
  try {
    directCandidates.push(network?.getMAC?.());
  } catch {
    // ignore runtime capability errors
  }
  try {
    directCandidates.push(network?.getMacAddress?.());
  } catch {
    // ignore runtime capability errors
  }
  try {
    directCandidates.push(network?.getMacAddr?.());
  } catch {
    // ignore runtime capability errors
  }

  for (const candidate of directCandidates) {
    const normalized = sanitizeMacAddress(typeof candidate === 'string' ? candidate : undefined);
    if (normalized) {
      return normalized;
    }

    const fromObject = findMacAddressInObject(candidate);
    if (fromObject) {
      return fromObject;
    }
  }

  const getPropertyValue = tizenWindow.tizen?.systeminfo?.getPropertyValue;
  if (typeof getPropertyValue !== 'function') {
    return undefined;
  }

  return await new Promise<string | undefined>((resolve) => {
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
      getPropertyValue(
        'NETWORK',
        (networkInfo: unknown) => {
          window.clearTimeout(timeout);
          const fromTree = findMacAddressInObject(networkInfo);
          if (fromTree) {
            finish(fromTree);
            return;
          }

          const fromField =
            typeof networkInfo === 'object' &&
            networkInfo !== null &&
            typeof (networkInfo as { macAddress?: unknown }).macAddress === 'string'
              ? sanitizeMacAddress((networkInfo as { macAddress: string }).macAddress)
              : undefined;
          finish(fromField);
        },
        () => {
          window.clearTimeout(timeout);
          finish(undefined);
        }
      );
    } catch {
      window.clearTimeout(timeout);
      finish(undefined);
    }
  });
};

const requestTizenDeviceFingerprint = (): string | undefined => {
  const tizenWindow = window as Window & {
    webapis?: {
      productinfo?: {
        getDuid?: () => string;
      };
    };
    tizen?: {
      systeminfo?: {
        getCapability?: (key: string) => unknown;
      };
    };
  };

  const candidates: Array<unknown> = [];
  try {
    candidates.push(tizenWindow.webapis?.productinfo?.getDuid?.());
  } catch {
    // ignore runtime capability errors
  }

  try {
    candidates.push(tizenWindow.tizen?.systeminfo?.getCapability?.('http://tizen.org/system/tizenid'));
  } catch {
    // ignore runtime capability errors
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = sanitizeFingerprint(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
};

const requestTizenModelName = (): string | undefined => {
  const tizenWindow = window as Window & {
    webapis?: {
      productinfo?: {
        getRealModel?: () => string;
        getModelCode?: () => string;
      };
    };
  };

  const candidates: Array<unknown> = [];
  try {
    candidates.push(tizenWindow.webapis?.productinfo?.getRealModel?.());
  } catch {
    // ignore runtime capability errors
  }

  try {
    candidates.push(tizenWindow.webapis?.productinfo?.getModelCode?.());
  } catch {
    // ignore runtime capability errors
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate
      .trim()
      .replace(/\s+/g, ' ');
    if (normalized) {
      return normalized.slice(0, 28);
    }
  }

  return undefined;
};

const parseRuntimeVersion = (value?: string): number | undefined => {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseFloat(normalized);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
};

const requestTizenPlatformVersion = (): number | undefined => {
  const tizenWindow = window as Window & {
    tizen?: {
      systeminfo?: {
        getCapability?: (key: string) => unknown;
      };
    };
  };

  const candidates: Array<unknown> = [];
  try {
    candidates.push(tizenWindow.tizen?.systeminfo?.getCapability?.(TIZEN_PLATFORM_VERSION_CAPABILITY));
  } catch {
    // ignore runtime capability errors
  }

  if (typeof navigator !== 'undefined') {
    candidates.push(navigator.userAgent);
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }

    if (typeof candidate !== 'string') {
      continue;
    }

    const direct = parseRuntimeVersion(candidate);
    if (typeof direct === 'number') {
      return direct;
    }

    const uaMatch = candidate.match(TIZEN_UA_VERSION_REGEX);
    const uaParsed = parseRuntimeVersion(uaMatch?.[1]);
    if (typeof uaParsed === 'number') {
      return uaParsed;
    }
  }

  return undefined;
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

const detectTizenEmulatorRuntime = (modelName?: string): boolean => {
  const ua = typeof navigator === 'undefined' ? '' : (navigator.userAgent || '');
  const model = (modelName ?? '').toLowerCase();
  const hints = `${ua} ${model}`.toLowerCase();
  return /emulator|sdk|goldfish|ranchu|simulator/.test(hints);
};

const applyEmulatorEpgInfoStyle = (profile: TizenRuntimeProfile): TizenRuntimeProfile => {
  if (!FORCE_EMULATOR_EPG_INFO_STYLE) {
    return profile;
  }

  return {
    ...profile,
    guideVisibleRows: 4,
    epgPollIntervalMs: 120000,
    epgDayRefreshIntervalMs: 300000,
    uiAutoHideTimeoutMs: Math.max(profile.uiAutoHideTimeoutMs, 22000),
    maxTimelineBlocksPerRow: 2,
    simplifyGuideRows: true,
    skipDayGrid: true
  };
};

const resolveTizenRuntimeProfile = (): TizenRuntimeProfile => {
  const platformVersion = requestTizenPlatformVersion();
  const modelName = requestTizenModelName();
  const cpuCores = requestHardwareConcurrency();
  const isEmulator = detectTizenEmulatorRuntime(modelName);
  const supportsGuidePreviewRect = false;

  if (isEmulator) {
    return {
      mode: 'emulator',
      platformVersion,
      modelName,
      isEmulator: true,
      supportsGuidePreviewRect: true,
      detachPlaybackInGuide: false,
      guideVisibleRows: BASE_GUIDE_VISIBLE_ROWS,
      epgPollIntervalMs: BASE_EPG_POLL_INTERVAL_MS,
      epgDayRefreshIntervalMs: BASE_EPG_DAY_REFRESH_INTERVAL_MS,
      uiAutoHideTimeoutMs: BASE_UI_AUTO_HIDE_TIMEOUT_MS,
      maxTimelineBlocksPerRow: 12,
      simplifyGuideRows: false,
      skipDayGrid: false
    };
  }

  let mode: TizenRuntimeMode = 'balanced';
  if (typeof platformVersion === 'number') {
    if (platformVersion < 4) {
      mode = 'legacy';
    } else if (platformVersion < 6) {
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

  if (mode === 'legacy') {
    const profile: TizenRuntimeProfile = {
      mode,
      platformVersion,
      modelName,
      isEmulator: false,
      supportsGuidePreviewRect: false,
      detachPlaybackInGuide: true,
      guideVisibleRows: 6,
      epgPollIntervalMs: 90000,
      epgDayRefreshIntervalMs: 180000,
      uiAutoHideTimeoutMs: 16000,
      maxTimelineBlocksPerRow: 4,
      simplifyGuideRows: true,
      skipDayGrid: false
    };
    return applyEmulatorEpgInfoStyle(profile);
  }

  if (mode === 'modern') {
    const profile: TizenRuntimeProfile = {
      mode,
      platformVersion,
      modelName,
      isEmulator: false,
      supportsGuidePreviewRect,
      detachPlaybackInGuide: true,
      guideVisibleRows: BASE_GUIDE_VISIBLE_ROWS,
      epgPollIntervalMs: BASE_EPG_POLL_INTERVAL_MS,
      epgDayRefreshIntervalMs: BASE_EPG_DAY_REFRESH_INTERVAL_MS,
      uiAutoHideTimeoutMs: BASE_UI_AUTO_HIDE_TIMEOUT_MS,
      maxTimelineBlocksPerRow: 12,
      simplifyGuideRows: false,
      skipDayGrid: false
    };
    return applyEmulatorEpgInfoStyle(profile);
  }

  const profile: TizenRuntimeProfile = {
    mode,
    platformVersion,
    modelName,
    isEmulator: false,
    supportsGuidePreviewRect,
    detachPlaybackInGuide: true,
    guideVisibleRows: 8,
    epgPollIntervalMs: 75000,
    epgDayRefreshIntervalMs: 150000,
    uiAutoHideTimeoutMs: 13000,
    maxTimelineBlocksPerRow: 7,
    simplifyGuideRows: true,
    skipDayGrid: false
  };
  return applyEmulatorEpgInfoStyle(profile);
};

const buildTizenDeviceIdentity = async (): Promise<{
  deviceName: string;
  fingerprint?: string;
  macAddress?: string;
}> => {
  const modelName = requestTizenModelName();
  const macAddress = await requestTizenMacAddress();
  const fallbackFingerprint = requestTizenDeviceFingerprint();
  const fingerprint = fallbackFingerprint ?? (macAddress ? normalizeFingerprint(macAddress) : undefined);
  const baseName = modelName ? `Samsung Tizen TV ${modelName}` : 'Samsung Tizen TV';
  return {
    deviceName: buildDeviceNameWithIdentity(baseName, macAddress, fingerprint),
    fingerprint,
    macAddress
  };
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

export const TizenApp: React.FC = () => {
  const [apiBase, setApiBase] = useState<string>(() => getInitialApiBase());
  const [view, setView] = useState<ScreenView>(() => (getStorageValue(DEVICE_TOKEN_KEY)?.trim() ? 'player' : 'pairing'));
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [isBuffering, setIsBuffering] = useState(false);
  const [bufferingPercent, setBufferingPercent] = useState<number>();
  const [isChannelInfoVisible, setIsChannelInfoVisible] = useState(true);

  const [pairingUrl, setPairingUrl] = useState<string>();
  const [pairingCode, setPairingCode] = useState<string>();
  const [isQrUnavailable, setIsQrUnavailable] = useState(false);
  const [deviceToken, setDeviceToken] = useState<string>();
  const pairPollingRef = useRef<number>();
  const epgPollingRef = useRef<number>();
  const epgDayRefreshRef = useRef(0);
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
  const [playbackOverride, setPlaybackOverride] = useState<PlaybackOverride>();
  const [showChannelList, setShowChannelList] = useState(false);
  const [isUiVisible, setIsUiVisible] = useState(true);
  const [menuView, setMenuView] = useState<MenuView>('epg');
  const [menuFocusZone, setMenuFocusZone] = useState<MenuFocusZone>('channels');
  const [channelNumberInput, setChannelNumberInput] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [audioOnlyWarning, setAudioOnlyWarning] = useState<string>();
  const [logoLoadFailed, setLogoLoadFailed] = useState(false);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef(new AvPlayAdapter());
  const isPlaybackPausedRef = useRef(false);
  const deviceIdentityNameRef = useRef<string>();
  const playbackLoadRequestIdRef = useRef(0);
  const loadedPlaybackUrlRef = useRef<string>();
  const loadedChannelIdRef = useRef<string>();
  const channelNumberTimerRef = useRef<number>();
  const channelInfoTimerRef = useRef<number>();
  const uiAutoHideTimerRef = useRef<number>();
  const playerInputGuardUntilRef = useRef(0);
  const lastChannelListOpenAtRef = useRef(0);
  const channelInfoPendingAfterMenuRef = useRef(false);
  const lastChannelInfoPlaybackKeyRef = useRef<string>();
  const enterHandledOnKeyDownRef = useRef(false);
  const enterKeyHeldRef = useRef(false);
  const backGuardPrimedRef = useRef(false);
  const channelNumberInputRef = useRef('');
  const channelButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const channelListRef = useRef<HTMLDivElement | null>(null);
  const runtimeProfile = useMemo(() => resolveTizenRuntimeProfile(), []);
  const isListOnlyMode = runtimeProfile.isEmulator && FORCE_LIST_ONLY_MODE_ON_EMULATOR;
  const guideVisibleRows = runtimeProfile.guideVisibleRows;

  useEffect(() => {
    const tizenWindow = window as Window & {
      tizen?: {
        tvinputdevice?: {
          registerKeyBatch?: (keys: string[]) => void;
          registerKey?: (key: string) => void;
          getSupportedKeys?: () => Array<{ name?: string; code?: number }>;
        };
      };
    };
    const tvInput = tizenWindow.tizen?.tvinputdevice;
    if (!tvInput) {
      return;
    }

    const keys = [
      'ChannelUp',
      'ChannelDown',
      'MediaChannelUp',
      'MediaChannelDown',
      'PreviousChannel',
      'ChannelList',
      'ColorF0Red',
      'ColorF1Green',
      'ColorF2Yellow',
      'ColorF3Blue',
      'MediaPlay',
      'MediaPause',
      'MediaPlayPause',
      'MediaStop',
      'MediaRewind',
      'MediaFastForward',
      'Guide',
      'Info',
      'Tools',
      'PictureSize',
      'Exit',
      'MediaTrackPrevious',
      'MediaTrackNext'
    ];

    const optionalKeys = ['Enter', 'NaviEnter', 'PanelEnter', 'ChannelList'];
    const supportedNames = (() => {
      try {
        const supported = tvInput.getSupportedKeys?.();
        if (!Array.isArray(supported)) {
          return [] as string[];
        }
        return supported
          .map((item) => String(item?.name ?? '').trim())
          .filter((name) => name.length > 0);
      } catch {
        return [] as string[];
      }
    })();
    const allKeys = Array.from(new Set([...keys, ...optionalKeys, ...supportedNames]));

    try {
      if (typeof tvInput.registerKey === 'function') {
        allKeys.forEach((key) => {
          try {
            tvInput.registerKey?.(key);
          } catch {
            // Ignore unsupported keys per model/firmware.
          }
        });
      } else if (typeof tvInput.registerKeyBatch === 'function') {
        tvInput.registerKeyBatch(allKeys);
      }
    } catch {
      // Ignore registration failures on emulator/browser.
    }
  }, []);

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

  const selectedChannel = useMemo(() => {
    if (!categoryChannels.length) {
      return undefined;
    }
    if (selectedIndex < 0 || selectedIndex >= categoryChannels.length) {
      return categoryChannels[0];
    }
    return categoryChannels[selectedIndex];
  }, [categoryChannels, selectedIndex]);

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
      const fromDayGrid = resolvedTvgId ? epgDayByTvgId[resolvedTvgId] : undefined;
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
    [epgDayByTvgId, getNowNextForChannel]
  );
  const getGuideProgramForChannelAtFocus = useCallback(
    (channel?: Channel): EpgProgramItem | undefined => {
      if (!channel) {
        return undefined;
      }
      const programs = getProgramsForChannel(channel);
      return findGuideProgramAtTime(programs, guideFocusTimeMs);
    },
    [getProgramsForChannel, guideFocusTimeMs]
  );
  const getGuideProgramCells = useCallback(
    (channel?: Channel): Array<EpgProgramItem | undefined> => {
      if (!channel) {
        return [undefined, undefined, undefined];
      }

      const programs = getProgramsForChannel(channel);
      if (programs.length === 0) {
        return [undefined, undefined, undefined];
      }

      const focusProgram = findGuideProgramAtTime(programs, guideFocusTimeMs);
      let startIndex = focusProgram ? programs.findIndex((program) => program === focusProgram) : -1;
      if (startIndex < 0) {
        const fallbackIndex = programs.findIndex((program) => {
          const startMs = parseProgramTimestamp(program.start);
          return typeof startMs === 'number' && startMs >= guideFocusTimeMs;
        });
        startIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
      }

      return [programs[startIndex], programs[startIndex + 1], programs[startIndex + 2]];
    },
    [getProgramsForChannel, guideFocusTimeMs]
  );
  const nowMs = Date.now();
  const playingChannelPrograms = useMemo(
    () => getProgramsForChannel(playingChannel),
    [getProgramsForChannel, playingChannel]
  );
  const playingProgramFallback = useMemo(
    () => resolveDisplayNowNext(playingChannelPrograms, nowMs),
    [playingChannelPrograms, nowMs]
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
  const focusedGuideProgram = useMemo(
    () => getGuideProgramForChannelAtFocus(selectedGuideChannel),
    [getGuideProgramForChannelAtFocus, selectedGuideChannel]
  );
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
  const canAutoHideUi = !isListOnlyMode && view === 'player' && channels.length > 0 && Boolean(playingChannel?.id);
  useEffect(() => {
    setLogoLoadFailed(false);
  }, [playingChannelLogo, playingChannelId]);

  useEffect(() => {
    if (!playingChannelId || !playingChannel) {
      return;
    }

    setStorageValue(LAST_PLAYING_CHANNEL_ID_KEY, playingChannelId);
    if (playingChannel.url?.trim()) {
      setStorageValue(LAST_PLAYING_CHANNEL_URL_KEY, playingChannel.url.trim());
    } else {
      removeStorageValue(LAST_PLAYING_CHANNEL_URL_KEY);
    }

    if (playingChannel.tvgId?.trim()) {
      setStorageValue(LAST_PLAYING_CHANNEL_TVG_ID_KEY, playingChannel.tvgId.trim());
    } else {
      removeStorageValue(LAST_PLAYING_CHANNEL_TVG_ID_KEY);
    }

    if (playingChannel.name?.trim()) {
      setStorageValue(LAST_PLAYING_CHANNEL_NAME_KEY, playingChannel.name.trim());
    } else {
      removeStorageValue(LAST_PLAYING_CHANNEL_NAME_KEY);
    }
  }, [playingChannel, playingChannelId]);

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

  const clearChannelInfoTimer = useCallback(() => {
    if (channelInfoTimerRef.current) {
      window.clearTimeout(channelInfoTimerRef.current);
      channelInfoTimerRef.current = undefined;
    }
  }, []);

  const clearUiAutoHideTimer = useCallback(() => {
    if (uiAutoHideTimerRef.current) {
      window.clearTimeout(uiAutoHideTimerRef.current);
      uiAutoHideTimerRef.current = undefined;
    }
  }, []);

  const hideBufferingIndicator = useCallback(() => {
    setIsBuffering(false);
    setBufferingPercent(undefined);
  }, []);

  useEffect(() => {
    if (view !== 'player') {
      clearChannelInfoTimer();
      setIsChannelInfoVisible(true);
      channelInfoPendingAfterMenuRef.current = false;
      lastChannelInfoPlaybackKeyRef.current = undefined;
      return;
    }

    const overrideUrl =
      playbackOverride && playingChannelId && playbackOverride.channelId === playingChannelId ? playbackOverride.url.trim() : '';
    const playbackKey = playingChannelId ? `${playingChannelId}|${overrideUrl}` : '';
    if (!playbackKey) {
      clearChannelInfoTimer();
      setIsChannelInfoVisible(false);
      channelInfoPendingAfterMenuRef.current = false;
      lastChannelInfoPlaybackKeyRef.current = '';
      return;
    }

    const keyChanged = lastChannelInfoPlaybackKeyRef.current !== playbackKey;
    if (keyChanged) {
      lastChannelInfoPlaybackKeyRef.current = playbackKey;
    }

    if (showChannelList) {
      if (keyChanged) {
        channelInfoPendingAfterMenuRef.current = true;
      }
      return;
    }

    if (!keyChanged && !channelInfoPendingAfterMenuRef.current) {
      return;
    }

    channelInfoPendingAfterMenuRef.current = false;
    clearChannelInfoTimer();
    setIsUiVisible(true);
    setIsChannelInfoVisible(true);
    channelInfoTimerRef.current = window.setTimeout(() => {
      setIsChannelInfoVisible(false);
    }, CHANNEL_INFO_OVERLAY_TIMEOUT_MS);
  }, [clearChannelInfoTimer, playbackOverride, playingChannelId, showChannelList, view]);

  const scheduleUiAutoHide = useCallback(() => {
    clearUiAutoHideTimer();
    if (!canAutoHideUi) {
      setIsUiVisible(true);
      return;
    }
    const autoHideDelayMs = runtimeProfile.uiAutoHideTimeoutMs;
    uiAutoHideTimerRef.current = window.setTimeout(() => {
      setIsUiVisible(false);
      setShowChannelList(false);
      setMenuView('epg');
      setMenuFocusZone('channels');
      clearChannelNumberTimer();
      channelNumberInputRef.current = '';
      setChannelNumberInput('');
    }, autoHideDelayMs);
  }, [canAutoHideUi, clearChannelNumberTimer, clearUiAutoHideTimer, runtimeProfile.uiAutoHideTimeoutMs]);

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
    if (isListOnlyMode) {
      setPlayingChannelId((currentId) => (currentId === channelId ? currentId : channelId));
      return;
    }
    setAudioOnlyWarning(undefined);
    setPlaybackOverride(undefined);
    setPlayingChannelId((currentId) => (currentId === channelId ? currentId : channelId));
  }, [isListOnlyMode]);

  const playArchiveChannelById = useCallback((channelId: string, archiveUrl: string, label: string): void => {
    if (isListOnlyMode) {
      setPlayingChannelId((currentId) => (currentId === channelId ? currentId : channelId));
      return;
    }
    setAudioOnlyWarning(undefined);
    setPlaybackOverride({
      channelId,
      url: archiveUrl,
      label
    });
    setPlayingChannelId(channelId);
  }, [isListOnlyMode]);

  const openChannelList = useCallback(
    (_focusZone: MenuFocusZone = 'channels', nextMenuView: MenuView = 'epg') => {
      setIsUiVisible(true);
      clearUiAutoHideTimer();
      lastChannelListOpenAtRef.current = Date.now();
      setMenuView(nextMenuView === 'epg' ? 'epg' : 'epg');
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
    [categories, channels, clearChannelNumberInput, clearUiAutoHideTimer, guideVisibleRows, playingChannelId]
  );

  const closeChannelList = useCallback(() => {
    registerPlayerActivity();
    setShowChannelList(false);
    setMenuView('epg');
    setMenuFocusZone('channels');
    clearChannelNumberInput();
  }, [clearChannelNumberInput, registerPlayerActivity]);

  const syncPlayerDisplayForMenu = useCallback((menuVisible: boolean) => {
    const avplay = window.webapis?.avplay;
    if (!avplay) {
      return;
    }

    if (menuVisible) {
      if (runtimeProfile.detachPlaybackInGuide) {
        // Player is fully torn down by the lifecycle effect while guide is open.
        return;
      }

      if (runtimeProfile.supportsGuidePreviewRect) {
        // Emulator + selected TV models render guide + small preview correctly.
        const previewRect = getMenuPreviewRect();
        playerRef.current.syncDisplayRect(previewRect);
        window.setTimeout(() => playerRef.current.syncDisplayRect(previewRect), 120);
        return;
      }
      // On many retail Samsung models, shrinking AVPlay makes the hardware plane
      // cover the rest of the UI with black. Keep fullscreen rect in menu mode.
      playerRef.current.syncDisplayRect();
      window.setTimeout(() => playerRef.current.syncDisplayRect(), 120);
      return;
    }

    if (runtimeProfile.detachPlaybackInGuide) {
      return;
    }

    playerRef.current.syncDisplayRect();
    window.setTimeout(() => playerRef.current.syncDisplayRect(), 120);
  }, [runtimeProfile.detachPlaybackInGuide, runtimeProfile.supportsGuidePreviewRect]);

  const stepCategory = useCallback(
    (delta: number) => {
      if (!categories.length) {
        return;
      }
      setSelectedCategoryIndex((prev) => wrapIndex(prev + delta, categories.length));
      setSelectedIndex(0);
      clearChannelNumberInput();
    },
    [categories.length, clearChannelNumberInput]
  );

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

  const selectChannelAtIndex = useCallback(
    (nextIndex: number, playNow: boolean) => {
      const channel = categoryChannels[nextIndex];
      if (!channel) {
        return;
      }
      setSelectedIndex(nextIndex);
      if (playNow) {
        playLiveChannelById(channel.id);
      }
    },
    [categoryChannels, playLiveChannelById]
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

  const stepGuideTimeline = useCallback(
    (delta: number) => {
      const deltaMs = delta * GUIDE_TIMELINE_STEP_MS;
      setGuideFocusTimeMs((current) => {
        const next = current + deltaMs;
        setGuideWindowStartMs((currentStart) => {
          const currentEnd = currentStart + GUIDE_TIMELINE_WINDOW_MS;
          if (next >= currentStart && next <= currentEnd) {
            return currentStart;
          }
          return getGuideWindowStart(next);
        });
        return next;
      });
      clearChannelNumberInput();
    },
    [clearChannelNumberInput]
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
    if (isListOnlyMode) {
      setStatusMessage('List-only preview mode: playback disabled.');
      return;
    }
    try {
      playerRef.current.play();
      isPlaybackPausedRef.current = false;
    } catch {
      hideBufferingIndicator();
    }
  }, [hideBufferingIndicator, isListOnlyMode]);

  const pauseCurrentVideo = useCallback(() => {
    if (isListOnlyMode) {
      return;
    }
    try {
      playerRef.current.pause();
      isPlaybackPausedRef.current = true;
    } catch {
      // ignore pause failures
    }
  }, [isListOnlyMode]);

  const togglePlayPause = useCallback(() => {
    if (isPlaybackPausedRef.current) {
      playCurrentVideo();
      return;
    }

    pauseCurrentVideo();
  }, [pauseCurrentVideo, playCurrentVideo]);

  const resolveDeviceNameForRequests = useCallback(async (): Promise<string | undefined> => {
    const cached = deviceIdentityNameRef.current?.trim();
    if (cached) {
      return cached;
    }

    const identity = await buildTizenDeviceIdentity();
    const deviceName = identity.deviceName.trim();
    if (!deviceName) {
      return undefined;
    }

    deviceIdentityNameRef.current = deviceName;
    return deviceName;
  }, []);

  const probeStoredDeviceToken = useCallback(
    async (token: string): Promise<{ invalid: boolean; resolvedBase?: string }> => {
      const candidates = buildApiBaseCandidates(apiBase);
      const deviceNameHeader = await resolveDeviceNameForRequests();

      for (const candidateBase of candidates) {
        try {
          const response = (await Promise.race([
            fetch(`${candidateBase}/device/profile`, {
              method: 'GET',
              headers: {
                'x-device-token': token,
                ...(deviceNameHeader ? { 'x-device-name': deviceNameHeader } : {})
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
    [apiBase, resolveDeviceNameForRequests]
  );

  const restoreTokenByFingerprint = useCallback(
    async (
      fingerprint?: string,
      deviceName?: string
    ): Promise<{ deviceToken?: string; deviceName?: string; resolvedBase?: string }> => {
      const normalizedFingerprint = sanitizeFingerprint(fingerprint);
      const normalizedDeviceName = (deviceName ?? '').trim();
      const candidates = buildApiBaseCandidates(apiBase);

      for (const candidateBase of candidates) {
        try {
          const params = new URLSearchParams({ platform: 'tizen' });
          if (normalizedFingerprint) {
            params.set('fingerprint', normalizedFingerprint);
          }
          if (normalizedDeviceName) {
            params.set('name', normalizedDeviceName);
          }

          const response = await fetchJson<RestoreTokenResponse>(
            `${candidateBase}/devices/restore-token?${params.toString()}`
          );
          if (response.restored && typeof response.deviceToken === 'string' && response.deviceToken.trim()) {
            return {
              deviceToken: response.deviceToken.trim(),
              deviceName: response.deviceName,
              resolvedBase: candidateBase
            };
          }

          return {
            resolvedBase: candidateBase
          };
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
      const deviceNameHeader = await resolveDeviceNameForRequests();

      let response: EpgNowNextResponse | undefined;
      let usedBase = candidates[0];
      let lastError: unknown;

      for (const candidateBase of candidates) {
        try {
          response = await fetchJson<EpgNowNextResponse>(`${candidateBase}/device/epg/now-next`, {
            headers: {
              'x-device-token': normalizedToken,
              ...(deviceNameHeader ? { 'x-device-name': deviceNameHeader } : {})
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
    [apiBase, resolveDeviceNameForRequests]
  );

  const loadDayGridForToken = useCallback(
    async (token: string, dayKey: string): Promise<void> => {
      const normalizedToken = token.trim();
      if (!normalizedToken) {
        setEpgDayByTvgId({});
        return;
      }

      const candidates = buildApiBaseCandidates(apiBase);
      const deviceNameHeader = await resolveDeviceNameForRequests();

      let response: EpgDayResponse | undefined;
      let usedBase = candidates[0];
      let lastError: unknown;

      for (const candidateBase of candidates) {
        try {
          response = await fetchJson<EpgDayResponse>(
            `${candidateBase}/device/epg/day?date=${encodeURIComponent(dayKey)}`,
            {
              headers: {
                'x-device-token': normalizedToken,
                ...(deviceNameHeader ? { 'x-device-name': deviceNameHeader } : {})
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

      if (usedBase !== apiBase) {
        setApiBase(usedBase);
        setStorageValue(API_BASE_KEY, usedBase);
      }

      const mapped: Record<string, EpgProgramItem[]> = {};
      const items = Array.isArray(response.items) ? response.items : [];
      for (const item of items) {
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
            return Boolean(program && typeof program.title === 'string' && typeof start === 'number' && typeof end === 'number');
          })
          .sort((left, right) => {
            const leftStart = parseProgramTimestamp(left.start) ?? 0;
            const rightStart = parseProgramTimestamp(right.start) ?? 0;
            return leftStart - rightStart;
          });
        if (validPrograms.length > 0) {
          mapped[tvgId] = validPrograms;
        }
      }

      setEpgDayByTvgId(mapped);
      setEpgDayDate(dayKey);
      epgDayRefreshRef.current = Date.now();
    },
    [apiBase, resolveDeviceNameForRequests]
  );

  const loadPlaylist = useCallback(
    async (token: string) => {
      const candidates = buildApiBaseCandidates(apiBase);
      const deviceNameHeader = await resolveDeviceNameForRequests();

      let response: PlaylistResponse | undefined;
      let usedBase = candidates[0];
      let lastError: unknown;

      for (const candidateBase of candidates) {
        try {
          response = await fetchJson<PlaylistResponse>(`${candidateBase}/device/playlist`, {
            headers: {
              'x-device-token': token,
              ...(deviceNameHeader ? { 'x-device-name': deviceNameHeader } : {})
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
      const savedPlayingChannelUrl = getStorageValue(LAST_PLAYING_CHANNEL_URL_KEY)?.trim();
      const savedPlayingChannelTvgId = getStorageValue(LAST_PLAYING_CHANNEL_TVG_ID_KEY)?.trim();
      const savedPlayingChannelName = getStorageValue(LAST_PLAYING_CHANNEL_NAME_KEY)?.trim();
      const restoredPlayingChannelId = resolveRestoredChannelId(
        resolvedChannels,
        savedPlayingChannelId,
        savedPlayingChannelUrl,
        savedPlayingChannelTvgId,
        savedPlayingChannelName
      );

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
      setPlayingChannelId(isListOnlyMode ? undefined : restoredPlayingChannelId);
      setPlaybackOverride(undefined);
      setShowChannelList(isListOnlyMode);
      setMenuView('epg');
      setMenuFocusZone('channels');
      setAudioOnlyWarning(undefined);
      clearChannelNumberInput();
      playerInputGuardUntilRef.current = Date.now() + PLAYER_INPUT_GUARD_MS;
      setView('player');
      setErrorMessage(undefined);
      setStatusMessage(
        isListOnlyMode
          ? resolvedChannels.length > 0
            ? `Connected. Loaded ${resolvedChannels.length} channels. List-only preview mode.`
            : 'Paired successfully. No channels configured yet.'
          : resolvedChannels.length > 0
            ? `Connected. Loaded ${resolvedChannels.length} channels.`
            : 'Paired successfully. No channels configured yet.'
      );

      loadNowNextForToken(token).catch(() => {
        // EPG is optional; keep playback active even if now-next request fails.
      });
      if (!runtimeProfile.skipDayGrid) {
        loadDayGridForToken(token, getLocalDateKey(new Date())).catch(() => {
          // Keep playback active if day EPG fails.
        });
      }
    },
    [
      apiBase,
      clearChannelNumberInput,
      isListOnlyMode,
      loadDayGridForToken,
      loadNowNextForToken,
      resolveDeviceNameForRequests,
      runtimeProfile.skipDayGrid
    ]
  );

  const startPairing = useCallback(async () => {
    const requestId = startPairingRequestRef.current + 1;
    startPairingRequestRef.current = requestId;
    clearPairPolling();
    clearEpgPolling();
    setView('pairing');
    setErrorMessage(undefined);
    setStatusMessage('Generating pairing code...');
    setPairingUrl(undefined);
    setPairingCode(undefined);
    setIsQrUnavailable(false);
    setDeviceToken(undefined);
    setEpgNowNextByChannelId({});
    setEpgDayByTvgId({});
    setEpgDayDate(getLocalDateKey(new Date()));
    setGuideFocusTimeMs(Date.now());
    setGuideWindowStartMs(getGuideWindowStart(Date.now()));
    setPlaybackOverride(undefined);
    const identity = await buildTizenDeviceIdentity();
    const deviceName = identity.deviceName;
    deviceIdentityNameRef.current = deviceName;

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
            platform: 'tizen'
          })
        });
        usedBase = candidateBase;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!started) {
      const detail = lastError instanceof Error ? lastError.message : FETCH_ERROR_MESSAGE;
      throw new Error(`${FETCH_ERROR_MESSAGE}. tried: ${candidates.join(' | ')}. last: ${detail}`);
    }

    if (usedBase !== apiBase) {
      setApiBase(usedBase);
      setStorageValue(API_BASE_KEY, usedBase);
    }

    if (startPairingRequestRef.current !== requestId) {
      return;
    }

    setPairingUrl(`${getWebAdminBase(usedBase)}/?pairCode=${encodeURIComponent(started.code)}`);
    setPairingCode(started.code);
    setIsQrUnavailable(false);
    pairPollFailureCountRef.current = 0;
    setStatusMessage('Scan QR and confirm pair in web-admin.');

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
            setPairingUrl(undefined);
            setPairingCode(undefined);
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
  }, [apiBase, clearEpgPolling, clearPairPolling, loadPlaylist]);

  const logoutDevice = useCallback(() => {
    clearPairPolling();
    clearEpgPolling();
    removeStorageValue(DEVICE_TOKEN_KEY);
    removeStorageValue(LAST_PLAYING_CHANNEL_ID_KEY);
    removeStorageValue(LAST_PLAYING_CHANNEL_URL_KEY);
    removeStorageValue(LAST_PLAYING_CHANNEL_TVG_ID_KEY);
    removeStorageValue(LAST_PLAYING_CHANNEL_NAME_KEY);
    deviceIdentityNameRef.current = undefined;
    clearChannelInfoTimer();
    hideBufferingIndicator();
    playbackLoadRequestIdRef.current += 1;
    channelInfoPendingAfterMenuRef.current = false;
    lastChannelInfoPlaybackKeyRef.current = undefined;
    setDeviceToken(undefined);
    setChannels([]);
    setEpgNowNextByChannelId({});
    setEpgDayByTvgId({});
    setEpgDayDate(getLocalDateKey(new Date()));
    setSelectedCategoryIndex(0);
    setSelectedIndex(0);
    setGuideSelectedIndex(0);
    setGuideListStartIndex(0);
    setGuideFocusTimeMs(Date.now());
    setGuideWindowStartMs(getGuideWindowStart(Date.now()));
    setPlayingChannelId(undefined);
    setPlaybackOverride(undefined);
    setShowChannelList(false);
    setMenuView('epg');
    setMenuFocusZone('channels');
    setChannelNumberInput('');
    setIsMuted(false);
    setIsChannelInfoVisible(true);
    channelNumberInputRef.current = '';
    clearChannelNumberTimer();
    setAudioOnlyWarning(undefined);
    setPairingUrl(undefined);
    setView('pairing');
    setStatusMessage('Disconnected. Generating a new QR...');
    setErrorMessage(undefined);
    startPairing().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : FETCH_ERROR_MESSAGE;
      setErrorMessage(message);
    });
  }, [clearChannelInfoTimer, clearChannelNumberTimer, clearEpgPolling, clearPairPolling, hideBufferingIndicator, startPairing]);

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
      setView('pairing');
      const identity = await buildTizenDeviceIdentity();
      deviceIdentityNameRef.current = identity.deviceName;
      setStatusMessage(
        identity.fingerprint
          ? `Restoring TV from database (${identity.fingerprint})...`
          : 'Restoring TV from database...'
      );

      const restored = await restoreTokenByFingerprint(identity.fingerprint, identity.deviceName);
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
  }, [apiBase, loadPlaylist, probeStoredDeviceToken, restoreTokenByFingerprint, startPairing]);

  useEffect(() => {
    const shouldDetachForGuide = runtimeProfile.detachPlaybackInGuide && showChannelList;
    if (isListOnlyMode || view !== 'player' || shouldDetachForGuide) {
      return;
    }
    const player = playerRef.current;
    const container = playerContainerRef.current;
    if (!container) {
      return;
    }

    let mounted = true;
    player
      .init(container)
      .then(() => {
        if (!mounted) {
          return;
        }
        player.syncDisplayRect();
      })
      .catch(() => {
        hideBufferingIndicator();
      });

    const unsubscribeState = player.on('state', (payload) => {
      if (!mounted || !payload || typeof payload !== 'object') {
        return;
      }

      const statePayload = payload as { state?: unknown; percent?: unknown };
      const playerState = typeof statePayload.state === 'string' ? statePayload.state : '';
      if (!playerState) {
        return;
      }

      if (playerState === 'buffering_start') {
        setIsBuffering(true);
        setBufferingPercent(0);
        return;
      }

      if (playerState === 'buffering') {
        const rawPercent = Number(statePayload.percent);
        const normalizedPercent = Number.isFinite(rawPercent) ? Math.min(100, Math.max(0, Math.round(rawPercent))) : undefined;
        setIsBuffering(true);
        if (typeof normalizedPercent === 'number') {
          setBufferingPercent(normalizedPercent);
        }
        return;
      }

      if (playerState === 'buffering_complete' || playerState === 'ready') {
        hideBufferingIndicator();
      }
    });

    const unsubscribeError = player.on('error', () => {
      hideBufferingIndicator();
    });

    return () => {
      mounted = false;
      playbackLoadRequestIdRef.current += 1;
      hideBufferingIndicator();
      unsubscribeState();
      unsubscribeError();
      loadedPlaybackUrlRef.current = undefined;
      loadedChannelIdRef.current = undefined;
      player.destroy();
    };
  }, [hideBufferingIndicator, isListOnlyMode, runtimeProfile.detachPlaybackInGuide, showChannelList, view]);

  useEffect(() => {
    if (isListOnlyMode || view !== 'player') {
      return;
    }

    syncPlayerDisplayForMenu(showChannelList);
    const onResize = () => {
      syncPlayerDisplayForMenu(showChannelList);
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [isListOnlyMode, showChannelList, syncPlayerDisplayForMenu, view]);

  useEffect(() => {
    if (isListOnlyMode || view !== 'player' || showChannelList || !playingChannel) {
      return;
    }

    const playbackUrlRaw =
      playbackOverride && playbackOverride.channelId === playingChannel.id
        ? playbackOverride.url
        : playingChannel.url;
    const playbackUrl = playbackUrlRaw.trim();
    if (!playbackUrl) {
      hideBufferingIndicator();
      return;
    }
    setAudioOnlyWarning(undefined);

    const sameLoadedStream =
      loadedPlaybackUrlRef.current === playbackUrl && loadedChannelIdRef.current === playingChannel.id;
    if (sameLoadedStream) {
      hideBufferingIndicator();
      if (isPlaybackPausedRef.current) {
        playerRef.current.play();
        isPlaybackPausedRef.current = false;
      }
      playerRef.current.syncDisplayRect();
      return;
    }

    const requestId = playbackLoadRequestIdRef.current + 1;
    playbackLoadRequestIdRef.current = requestId;
    setIsBuffering(true);
    setBufferingPercent(0);

    playerRef.current
      .load(playbackUrl)
      .then(() => {
        if (playbackLoadRequestIdRef.current !== requestId) {
          return;
        }
        loadedPlaybackUrlRef.current = playbackUrl;
        loadedChannelIdRef.current = playingChannel.id;
        playerRef.current.play();
        isPlaybackPausedRef.current = false;
        playerRef.current.syncDisplayRect();
      })
      .catch(() => {
        if (playbackLoadRequestIdRef.current !== requestId) {
          return;
        }
        hideBufferingIndicator();
      });
  }, [hideBufferingIndicator, isListOnlyMode, playbackOverride, playingChannel, showChannelList, view]);

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
    if (view !== 'player' || !deviceToken || !showChannelList || menuView !== 'epg' || runtimeProfile.skipDayGrid) {
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
    runtimeProfile.skipDayGrid,
    showChannelList,
    view
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      try {
        const remoteInput = getRemoteInput(event);
        const { action, digit } = remoteInput;
        if (DEBUG_REMOTE_OK_KEY && view === 'player' && (action === 'ENTER' || action === 'NONE')) {
          setIsUiVisible(true);
          setStatusMessage(`KEY ${action} | key:${event.key || '-'} code:${event.code || '-'} keyCode:${event.keyCode}`);
        }
        if (action === 'NONE') {
          return;
        }

        if (action === 'ENTER') {
          if (enterKeyHeldRef.current || event.repeat) {
            event.preventDefault();
            return;
          }
          enterKeyHeldRef.current = true;
        }

        if (action === 'ENTER' || action === 'LIST' || action === 'GUIDE' || action === 'INFO' || action === 'MENU') {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
          }
        }

        if (view === 'player') {
          if (
            Date.now() < playerInputGuardUntilRef.current &&
            (action === 'ENTER' ||
              action === 'LIST' ||
              action === 'GUIDE' ||
              action === 'INFO' ||
              action === 'MENU' ||
              action === 'RED' ||
              action === 'BLUE')
          ) {
            event.preventDefault();
            return;
          }

          registerPlayerActivity();

          if (action === 'DIGIT' && Number.isFinite(digit)) {
            event.preventDefault();
            pushChannelNumberDigit(digit as number);
            return;
          }

          if (
            !showChannelList &&
            (action === 'ENTER' || action === 'LIST' || action === 'GUIDE' || action === 'INFO' || action === 'MENU')
          ) {
            event.preventDefault();
            enterHandledOnKeyDownRef.current = true;
            openChannelList('channels', 'epg');
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
            pauseCurrentVideo();
            return;
          }

          if (action === 'PLAY_PAUSE') {
            event.preventDefault();
            togglePlayPause();
            return;
          }

          if (action === 'STOP') {
            event.preventDefault();
            pauseCurrentVideo();
            openChannelList('channels', 'epg');
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

          if (!showChannelList && action === 'UP') {
            event.preventDefault();
            stepChannelAndPlay(-1);
            return;
          }

          if (!showChannelList && action === 'DOWN') {
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
            if (Date.now() - lastChannelListOpenAtRef.current < OPEN_MENU_ENTER_GUARD_MS) {
              return;
            }
            const guideChannel = channels[guideSelectedIndex];
            if (isListOnlyMode) {
              if (guideChannel) {
                setStatusMessage(`Preview channel: ${guideChannel.name}`);
              }
              clearChannelNumberInput();
              return;
            }
            if (guideChannel) {
              const focusedProgram = getGuideProgramForChannelAtFocus(guideChannel);
              const focusedProgramEnd = parseProgramTimestamp(focusedProgram?.end);
              const archiveDays = resolveArchiveDays(guideChannel);
              const canPlayArchive =
                Boolean(focusedProgram) &&
                typeof focusedProgramEnd === 'number' &&
                focusedProgramEnd <= Date.now() &&
                archiveDays > 0;

              if (focusedProgram && canPlayArchive) {
                const archiveUrl = buildArchiveUrl(guideChannel, focusedProgram);
                if (archiveUrl) {
                  playArchiveChannelById(
                    guideChannel.id,
                    archiveUrl,
                    `${focusedProgram.title} (${formatProgramRange(focusedProgram)})`
                  );
                  closeChannelList();
                  clearChannelNumberInput();
                  setStatusMessage(`Arhiva: ${guideChannel.name} - ${focusedProgram.title}`);
                  return;
                }
              }

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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? 'remote key handling failed');
        if (view !== 'player') {
          setErrorMessage(message);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      try {
        const keyUpAction = getRemoteInput(event).action;
        if (keyUpAction === 'ENTER') {
          enterKeyHeldRef.current = false;
        }

        if (view !== 'player' || showChannelList) {
          return;
        }

        const action = keyUpAction;
        if (action === 'ENTER' || action === 'LIST' || action === 'GUIDE' || action === 'INFO' || action === 'MENU') {
          if (enterHandledOnKeyDownRef.current) {
            enterHandledOnKeyDownRef.current = false;
            return;
          }
          if (Date.now() - lastChannelListOpenAtRef.current < OPEN_MENU_ENTER_GUARD_MS) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
          }
          openChannelList('channels', 'epg');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? 'remote key handling failed');
        if (view !== 'player') {
          setErrorMessage(message);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [
    channels,
    clearChannelNumberInput,
    closeChannelList,
    getGuideProgramForChannelAtFocus,
    guideSelectedIndex,
    isListOnlyMode,
    openChannelList,
    pauseCurrentVideo,
    playArchiveChannelById,
    playCurrentVideo,
    playLiveChannelById,
    pushChannelNumberDigit,
    registerPlayerActivity,
    showChannelList,
    startPairing,
    stepGuideCategory,
    stepGuideTimeline,
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
    if (!canAutoHideUi) {
      clearUiAutoHideTimer();
      return;
    }
    scheduleUiAutoHide();
  }, [canAutoHideUi, clearUiAutoHideTimer, scheduleUiAutoHide, showChannelList, view]);

  useEffect(() => {
    if (!showChannelList) {
      clearChannelNumberInput();
    }
  }, [clearChannelNumberInput, showChannelList]);

  useEffect(() => {
    if (view !== 'player') {
      return;
    }
    syncPlayerDisplayForMenu(showChannelList);
  }, [showChannelList, syncPlayerDisplayForMenu, view]);

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
    const fullscreenGuideActive = showChannelList && runtimeProfile.detachPlaybackInGuide;
    if (!fullscreenGuideActive || menuView !== 'epg') {
      return;
    }

    const listElement = channelListRef.current;
    if (!listElement) {
      return;
    }

    const itemElement = channelButtonRefs.current[guideSelectedIndex];
    const fallbackTop = Math.max(0, (guideSelectedIndex - guideWindowRange.start) * GUIDE_CHANNEL_ROW_HEIGHT_PX);
    const itemTop = itemElement ? itemElement.offsetTop : fallbackTop;
    const itemBottom = itemElement ? itemElement.offsetTop + itemElement.offsetHeight : itemTop + GUIDE_CHANNEL_ROW_HEIGHT_PX;
    const listTop = listElement.scrollTop;
    const listBottom = listTop + listElement.clientHeight;

    if (itemBottom > listBottom) {
      listElement.scrollTop = itemBottom - listElement.clientHeight;
      return;
    }
    if (itemTop < listTop) {
      listElement.scrollTop = itemTop;
    }
  }, [guideSelectedIndex, guideWindowRange.start, menuView, runtimeProfile.detachPlaybackInGuide, showChannelList]);

  useEffect(() => {
    return () => {
      playbackLoadRequestIdRef.current += 1;
      clearChannelNumberInput();
      clearChannelInfoTimer();
      clearUiAutoHideTimer();
      clearPairPolling();
      clearEpgPolling();
      hideBufferingIndicator();
    };
  }, [clearChannelInfoTimer, clearChannelNumberInput, clearEpgPolling, clearPairPolling, clearUiAutoHideTimer, hideBufferingIndicator]);

  const pairingQrImageUrl = pairingUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(pairingUrl)}`
    : undefined;
  const guideGroupLabel = selectedGuideChannel?.groupName ?? selectedGuideChannel?.group ?? 'Toate canalele';
  const guideDayLabel = new Date(guideFocusTimeMs).toLocaleDateString('ro-RO', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit'
  });
  const guideClockLabel = new Date(nowMs).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
  const focusedProgramGenre = inferProgramGenre(focusedGuideProgram);
  const focusedProgramTitle = focusedGuideProgram?.title ?? 'EPG indisponibil';
  const focusedProgramDescription =
    focusedGuideProgram?.description?.trim() || 'Nu exista descriere pentru acest program.';
  const selectedGuideProgramCells = useMemo(
    () => getGuideProgramCells(selectedGuideChannel),
    [getGuideProgramCells, selectedGuideChannel]
  );
  const guideColumnLabels = useMemo(() => {
    return selectedGuideProgramCells.map((program, index) => {
      if (program) {
        const startMs = parseProgramTimestamp(program.start);
        if (typeof startMs === 'number') {
          return formatTimeFromTimestamp12h(startMs);
        }
      }
      return formatTimeFromTimestamp12h(guideFocusTimeMs + index * GUIDE_TIMELINE_STEP_MS);
    });
  }, [guideFocusTimeMs, selectedGuideProgramCells]);
  const selectedGuideNowNext = useMemo(
    () => getNowNextForChannel(selectedGuideChannel),
    [getNowNextForChannel, selectedGuideChannel]
  );
  const selectedGuideNowProgram = selectedGuideNowNext?.now ?? focusedGuideProgram;
  const selectedGuideNextProgram = selectedGuideNowNext?.next;
  const tizenMenuChannels = useMemo(() => {
    if (channels.length === 0) {
      return [] as Array<{ channel: Channel; index: number; offset: number }>;
    }

    if (channels.length <= TIZEN_MENU_VISIBLE_ITEMS) {
      return channels.map((channel, index) => ({
        channel,
        index,
        offset: index - guideSelectedIndex
      }));
    }

    const radius = Math.floor(TIZEN_MENU_VISIBLE_ITEMS / 2);
    const items: Array<{ channel: Channel; index: number; offset: number }> = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = wrapIndex(guideSelectedIndex + offset, channels.length);
      items.push({
        channel: channels[index],
        index,
        offset
      });
    }
    return items;
  }, [channels, guideSelectedIndex]);
  const focusedProgramEndMs = parseProgramTimestamp(focusedGuideProgram?.end);
  const selectedGuideArchiveDays = resolveArchiveDays(selectedGuideChannel);
  const canPlayFocusedArchive =
    Boolean(focusedGuideProgram) &&
    typeof focusedProgramEndMs === 'number' &&
    focusedProgramEndMs <= nowMs &&
    selectedGuideArchiveDays > 0;
  const shouldRenderGuideFullscreen = showChannelList && runtimeProfile.detachPlaybackInGuide;
  const guideNumberColWidth = 88;
  const guideLogoColWidth = 120;
  const guideNameColWidth = 360;
  const guideColGap = 10;
  const bufferingStatusText =
    typeof bufferingPercent === 'number' ? `Buffering ${Math.round(bufferingPercent)}%` : 'Buffering';

  if (view !== 'player') {
    return (
      <div className="setup">
        <div className="setup__panel">
          <div className="pairing pairing--solo">
            {pairingQrImageUrl && !isQrUnavailable ? (
              <img src={pairingQrImageUrl} alt="Pairing QR code" onError={() => setIsQrUnavailable(true)} />
            ) : (
              <p className="setup__hint">Generating QR code...</p>
            )}
            {pairingCode ? <pre>{pairingCode}</pre> : null}
            {pairingCode ? <p className="setup__hint">Daca QR nu apare, introdu codul in web-admin.</p> : null}
            {isQrUnavailable ? <p className="setup__hint">QR unavailable. Use pairing code in web-admin.</p> : null}
            {statusMessage ? <p className="setup__hint">{statusMessage}</p> : null}
            {errorMessage ? <p className="msg msg--error">{errorMessage}</p> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={showChannelList ? 'player is-menu-open' : 'player'}
      style={showChannelList ? { background: '#041a3b' } : undefined}
    >
      {!shouldRenderGuideFullscreen ? (
        <main className="screen">
          <div ref={playerContainerRef} className="video" />

          {isUiVisible && !showChannelList ? (
            <>
              {channelNumberInput ? (
                <div className="screen__overlay screen__overlay--top">
                  <div className="screen__chip-group">
                    <span className="screen__chip screen__chip--number">#{channelNumberInput}</span>
                  </div>
                </div>
              ) : null}

              {isChannelInfoVisible ? (
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
                      : 'OK: meniu canale | CH+/CH- sau UP/DOWN: schimba canal'}
                  </p>
                  {playbackOverride ? <p className="screen__hint">Arhiva activa: {playbackOverride.label}</p> : null}
                  {channels.length === 0 ? <p className="msg msg--ok screen__msg">Player pornit. Nu exista inca canale alocate.</p> : null}
                </div>
              ) : null}
            </>
          ) : null}

          {isBuffering && !showChannelList ? <div className="screen__buffering">{bufferingStatusText}</div> : null}
        </main>
      ) : null}

      {showChannelList ? (
        runtimeProfile.detachPlaybackInGuide ? (
          <aside
            className="epgx-guide"
            style={{
              position: 'fixed',
              inset: '0',
              width: '100vw',
              height: '100vh',
              zIndex: 2147483000,
              display: 'grid',
              gridTemplateRows: 'auto auto minmax(0, 1fr) auto',
              background: 'linear-gradient(180deg, #0a2a57 0%, #0c3b77 52%, #0b2f62 100%)',
              color: '#ffffff',
              fontFamily: "Tahoma, 'Segoe UI', sans-serif",
              border: 'none'
            }}
          >
            <header
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '16px',
                padding: '14px 18px',
                borderBottom: '2px solid rgba(196, 221, 255, 0.55)',
                background: 'rgba(10, 45, 92, 0.96)'
              }}
            >
              <div style={{ minWidth: 0 }}>
                <h2 style={{ margin: 0, fontSize: '46px', lineHeight: 1, fontWeight: 800 }}>TV GUIDE</h2>
                <p style={{ margin: '4px 0 0', fontSize: '19px', fontWeight: 700, opacity: 0.95 }}>
                  CH {guideSelectedIndex + 1} | {guideGroupLabel} | {guideDayLabel}
                </p>
              </div>
              <div style={{ fontSize: '38px', fontWeight: 800, whiteSpace: 'nowrap' }}>{guideClockLabel}</div>
            </header>
            <div
              style={{
                display: 'flex',
                flexWrap: 'nowrap',
                alignItems: 'center',
                padding: '10px 18px',
                borderBottom: '1px solid rgba(196, 221, 255, 0.4)',
                background: 'rgba(16, 66, 125, 0.85)',
                fontSize: '20px',
                fontWeight: 800
              }}
            >
              <span style={{ flex: `0 0 ${guideNumberColWidth}px`, width: `${guideNumberColWidth}px`, textAlign: 'left', marginRight: `${guideColGap}px` }}>
                Nr
              </span>
              <span style={{ flex: `0 0 ${guideLogoColWidth}px`, width: `${guideLogoColWidth}px`, textAlign: 'center', marginRight: `${guideColGap}px` }}>
                Logo
              </span>
              <span style={{ flex: `0 0 ${guideNameColWidth}px`, width: `${guideNameColWidth}px`, textAlign: 'left', marginRight: `${guideColGap}px` }}>
                Nume canal
              </span>
              <span style={{ position: 'relative', display: 'block', height: '30px', flex: '1 1 auto', minWidth: 0 }}>
                {guideTickMarks.map((tick) => (
                  <span
                    key={`tick-head:${tick.timeMs}`}
                    style={{
                      position: 'absolute',
                      left: `${tick.leftPct}%`,
                      transform: 'translateX(-50%)',
                      fontSize: '16px',
                      fontWeight: 800,
                      whiteSpace: 'nowrap',
                      opacity: 0.95
                    }}
                  >
                    {tick.label}
                  </span>
                ))}
              </span>
            </div>
            <div
              ref={(element) => {
                channelListRef.current = element;
              }}
              style={{ overflowY: 'auto', overflowX: 'hidden', padding: '10px 18px 12px' }}
            >
              {channels.length === 0 ? (
                <p style={{ fontSize: '24px', margin: 0 }}>Nu exista canale in playlist.</p>
              ) : (
                visibleGuideChannels.map((channel, localIndex) => {
                  const index = guideWindowRange.start + localIndex;
                  const isSelectedRow = index === guideSelectedIndex;
                  const archiveDays = resolveArchiveDays(channel);
                  const nowNext = getNowNextForChannel(channel);
                  const rowLogo = nowNext?.channelLogo ?? channel.logo;
                  const normalizedRowLogo = typeof rowLogo === 'string' ? rowLogo.trim() : '';
                  const showRowLogo = normalizedRowLogo.length > 0;
                  const programs = getProgramsForChannel(channel);

                  const timelineBlocks = programs
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
                      const widthPct = Math.max(((clippedEndMs - clippedStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100, 5);
                      return {
                        key: `${channel.id}:${programIndex}:${program.start}`,
                        program,
                        startMs,
                        endMs,
                        leftPct,
                        widthPct,
                        canArchive: endMs <= nowMs && archiveDays > 0
                      };
                    })
                    .filter((item): item is NonNullable<typeof item> => Boolean(item));

                  const focusMatch = timelineBlocks.find(
                    (block) => guideFocusTimeMs >= block.startMs && guideFocusTimeMs < block.endMs
                  );
                  const fallbackFocus = timelineBlocks.find((block) => block.startMs >= guideFocusTimeMs) ?? timelineBlocks[0];

                  return (
                    <button
                      key={`${channel.id}:${index}`}
                      type="button"
                      ref={(element) => {
                        channelButtonRefs.current[index] = element;
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        flexWrap: 'nowrap',
                        alignItems: 'center',
                        width: '100%',
                        minHeight: '98px',
                        marginBottom: '6px',
                        border: isSelectedRow ? '2px solid #ffffff' : '1px solid rgba(196, 221, 255, 0.35)',
                        background: isSelectedRow ? '#2e7ad1' : 'rgba(255, 255, 255, 0.08)',
                        color: '#fff',
                        textAlign: 'left',
                        padding: '8px 6px',
                        fontSize: '19px',
                        fontWeight: isSelectedRow ? 800 : 600,
                        boxSizing: 'border-box'
                      }}
                      onClick={() => {
                        setGuideSelectedIndex(index);
                        clearChannelNumberInput();
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'flex-start',
                          flex: `0 0 ${guideNumberColWidth}px`,
                          width: `${guideNumberColWidth}px`,
                          fontSize: '28px',
                          fontWeight: 900,
                          marginRight: `${guideColGap}px`
                        }}
                      >
                        {index + 1}
                      </span>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: `${guideLogoColWidth}px`,
                          height: '62px',
                          flex: `0 0 ${guideLogoColWidth}px`,
                          boxSizing: 'border-box',
                          padding: '0 8px',
                          border: '1px solid rgba(196, 221, 255, 0.45)',
                          borderRadius: '8px',
                          background: 'rgba(10, 29, 58, 0.65)',
                          overflow: 'hidden',
                          marginRight: `${guideColGap}px`
                        }}
                      >
                        {showRowLogo ? (
                          <img
                            src={normalizedRowLogo}
                            alt={`${channel.name} logo`}
                            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                          />
                        ) : (
                          <span style={{ fontSize: '22px', fontWeight: 800 }}>
                            {(channel.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </span>
                      <span
                        style={{
                          flex: `0 0 ${guideNameColWidth}px`,
                          width: `${guideNameColWidth}px`,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          fontSize: '23px',
                          fontWeight: isSelectedRow ? 800 : 700,
                          marginRight: `${guideColGap}px`
                        }}
                      >
                        {channel.name || `Canal ${index + 1}`}
                      </span>
                      <span
                        style={{
                          flex: '1 1 auto',
                          minWidth: 0,
                          position: 'relative',
                          display: 'block',
                          height: '78px',
                          borderRadius: '6px',
                          background: 'rgba(8, 18, 34, 0.28)',
                          overflow: 'hidden'
                        }}
                      >
                        {guideTickMarks.slice(1, -1).map((tick) => (
                          <span
                            key={`${channel.id}:tick:${tick.timeMs}`}
                            style={{
                              position: 'absolute',
                              left: `${tick.leftPct}%`,
                              top: 0,
                              bottom: 0,
                              width: '1px',
                              background: 'rgba(191, 215, 243, 0.25)'
                            }}
                          />
                        ))}
                        {showNowLine ? (
                          <span
                            style={{
                              position: 'absolute',
                              left: `${nowLinePct}%`,
                              top: 0,
                              bottom: 0,
                              width: '2px',
                              background: 'rgba(255, 235, 122, 0.92)'
                            }}
                          />
                        ) : null}
                        <span
                          style={{
                            position: 'absolute',
                            left: `${focusLinePct}%`,
                            top: 0,
                            bottom: 0,
                            width: '2px',
                            background: 'rgba(170, 223, 255, 0.82)'
                          }}
                        />

                        {timelineBlocks.length > 0 ? (
                          timelineBlocks.map((block) => {
                            const isFocusedBlock =
                              isSelectedRow && (focusMatch ? focusMatch.key === block.key : fallbackFocus?.key === block.key);
                            return (
                              <span
                                key={block.key}
                                style={{
                                  position: 'absolute',
                                  left: `${block.leftPct}%`,
                                  width: `${block.widthPct}%`,
                                  top: '6px',
                                  bottom: '6px',
                                  minWidth: '42px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  borderRadius: '4px',
                                  border: isFocusedBlock ? '2px solid #ffffff' : '1px solid rgba(196, 221, 255, 0.35)',
                                  background: isFocusedBlock
                                    ? 'linear-gradient(180deg, rgba(106, 185, 255, 0.96), rgba(56, 132, 211, 0.96))'
                                    : 'linear-gradient(180deg, rgba(82, 121, 158, 0.92), rgba(56, 87, 121, 0.92))',
                                  color: '#fff',
                                  padding: '0 6px',
                                  overflow: 'hidden',
                                  boxSizing: 'border-box'
                                }}
                              >
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    minWidth: 0,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    width: '100%'
                                  }}
                                >
                                  <span
                                    style={{
                                      minWidth: 0,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      fontSize: '15px',
                                      fontWeight: 800
                                    }}
                                  >
                                    {block.program.title}
                                  </span>
                                  <span style={{ flex: '0 0 auto', fontSize: '11px', opacity: 0.88 }}>
                                    {formatProgramRange(block.program)}
                                  </span>
                                  {block.canArchive ? (
                                    <span
                                      style={{
                                        flex: '0 0 auto',
                                        fontSize: '10px',
                                        fontWeight: 900,
                                        padding: '1px 4px',
                                        borderRadius: '3px',
                                        background: 'rgba(9, 33, 60, 0.45)'
                                      }}
                                    >
                                      ARHIVA
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                            );
                          })
                        ) : (
                          <span
                            style={{
                              position: 'absolute',
                              left: '0.6%',
                              right: '0.6%',
                              top: '10px',
                              bottom: '10px',
                              borderRadius: '4px',
                              border: isSelectedRow ? '2px solid #ffffff' : '1px solid rgba(196, 221, 255, 0.35)',
                              background: 'rgba(69, 99, 132, 0.7)',
                              padding: '8px 10px',
                              fontSize: '14px',
                              fontWeight: 700
                            }}
                          >
                            Fara EPG
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <footer
              style={{
                padding: '12px 20px',
                borderTop: '2px solid rgba(196, 221, 255, 0.55)',
                background: 'rgba(10, 45, 92, 0.96)',
                fontSize: '20px',
                fontWeight: 700
              }}
            >
              UP/DOWN canale | LEFT/RIGHT categorii | OK selecteaza canal/arhiva | BACK inchide
            </footer>
          </aside>
        ) : (
        <aside
          className="epgx-guide"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'grid',
            gridTemplateRows: 'auto auto auto minmax(0, 1fr) auto',
            background: 'linear-gradient(180deg, #0a2550 0%, #0c2c5f 46%, #08224a 100%)',
            color: '#ffffff',
            fontFamily: "Tahoma, 'Segoe UI', sans-serif"
          }}
        >
          <header
            className="epgx-guide__header"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              padding: '8px 12px',
              borderBottom: '1px solid #78a3d8',
              background: 'linear-gradient(180deg, #1f60ab, #144b8b)'
            }}
          >
            <div className="epgx-guide__title-wrap">
              <h2 className="epgx-guide__title" style={{ margin: 0, color: '#eff8ff', fontSize: '38px', lineHeight: 1 }}>
                TV Guide
              </h2>
              <p className="epgx-guide__meta" style={{ margin: '2px 0 0', color: '#fff', fontSize: '16px' }}>
                CH {guideSelectedIndex + 1} | {guideGroupLabel} | {guideDayLabel} | {guideClockLabel}
              </p>
            </div>
            <div className="epgx-guide__header-actions" aria-hidden="true">
              <span className="epgx-guide__clock" style={{ color: '#fff', fontSize: '24px', fontWeight: 800 }}>
                {guideClockLabel}
              </span>
            </div>
          </header>

          <section
            className="epgx-guide__hero"
            style={{
              padding: '8px 12px',
              borderBottom: '1px solid rgba(127, 165, 208, 0.7)',
              background: 'linear-gradient(180deg, rgba(16, 66, 124, 0.62), rgba(10, 46, 88, 0.68))'
            }}
          >
            <p style={{ margin: 0, fontSize: '34px', fontWeight: 800 }}>{selectedGuideChannel?.name ?? 'Canal'}</p>
            <p style={{ margin: '2px 0 0', fontSize: '20px', opacity: 0.95 }}>
              Acum: {selectedGuideNowProgram?.title ?? focusedProgramTitle}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: '18px', opacity: 0.9 }}>
              Urmeaza: {selectedGuideNextProgram?.title ?? '-'}
            </p>
          </section>

          <div
            className="epgx-guide__table-head"
            style={{
              display: 'grid',
              gridTemplateColumns: '72px 96px 300px minmax(0, 1fr)',
              alignItems: 'center',
              gap: '10px',
              padding: '6px 12px',
              borderTop: '1px solid rgba(146, 181, 223, 0.5)',
              borderBottom: '1px solid rgba(146, 181, 223, 0.5)',
              background: 'rgba(20, 79, 142, 0.65)',
              fontSize: '16px',
              fontWeight: 700
            }}
          >
            <span>Nr</span>
            <span>Logo</span>
            <span>Canal</span>
            <span>Acum</span>
          </div>

          <div
            ref={(element) => {
              channelListRef.current = element;
            }}
            className="epgx-guide__rows"
            style={{ overflow: 'hidden', padding: '6px 12px 8px' }}
          >
            {channels.length === 0 ? (
              <p className="epgx-guide__empty">Nu exista canale in playlist.</p>
            ) : (
              tizenMenuChannels.map(({ channel, index }) => {
                const isSelectedRow = index === guideSelectedIndex;
                const nowNext = getNowNextForChannel(channel);
                const rowLogo = nowNext?.channelLogo ?? channel.logo;
                const normalizedRowLogo = typeof rowLogo === 'string' ? rowLogo.trim() : '';
                const showRowLogo = normalizedRowLogo.length > 0;
                const nowTitle = nowNext?.now?.title ?? 'EPG indisponibil';

                return (
                  <button
                    key={`${channel.id}:${index}`}
                    type="button"
                    ref={(element) => {
                      channelButtonRefs.current[index] = element;
                    }}
                    className={isSelectedRow ? 'epgx-guide__row is-active' : 'epgx-guide__row'}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '72px 96px 300px minmax(0, 1fr)',
                      alignItems: 'center',
                      gap: '10px',
                      width: '100%',
                      minHeight: '56px',
                      marginBottom: '4px',
                      padding: '4px 0',
                      textAlign: 'left',
                      border: '1px solid rgba(120, 163, 216, 0.55)',
                      background: isSelectedRow ? 'rgba(58, 136, 210, 0.45)' : 'rgba(255, 255, 255, 0.05)',
                      color: '#fff'
                    }}
                    onClick={() => {
                      setGuideSelectedIndex(index);
                      clearChannelNumberInput();
                    }}
                    >
                    <span className="epgx-guide__row-number" style={{ fontWeight: 800 }}>{index + 1}</span>
                    <span className="epgx-guide__row-logo-col">
                      <span className="epgx-guide__row-logo-slot">
                        {showRowLogo ? (
                          <img className="epgx-guide__row-logo" src={normalizedRowLogo} alt={`${channel.name} logo`} />
                        ) : (
                          <span className="epgx-guide__row-logo-fallback">
                            {(channel.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="epgx-guide__row-name" style={{ fontWeight: 700 }}>
                      {channel.name || `Canal ${index + 1}`}
                    </span>
                    <span
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        fontWeight: isSelectedRow ? 800 : 600
                      }}
                    >
                      {nowTitle}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <footer className="epgx-guide__details" style={{ padding: '8px 12px', borderTop: '1px solid rgba(146, 181, 223, 0.74)' }}>
            <p className="epgx-guide__controls" style={{ margin: 0, color: '#fff', fontSize: '18px' }}>
              UP/DOWN: Canale | LEFT/RIGHT: Categorii | OK: Selecteaza | BACK: Inchide
            </p>
          </footer>
        </aside>
        )
      ) : null}
    </div>
  );
};


