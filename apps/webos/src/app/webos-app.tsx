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

interface PlaybackOverride {
  channelId: string;
  url: string;
  label: string;
}

type ScreenView = 'pairing' | 'player';
type MenuFocusZone = 'categories' | 'channels';
type MenuView = 'channels' | 'epg';
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
  'http://10.0.0.247:3000',
  'http://10.0.0.246:3000',
  'http://192.168.100.4:3000',
  'http://10.0.2.2:3000',
  'http://172.17.0.1:3000'
];

const AUDIO_ONLY_DETECT_MS = 2500;
const CHANNEL_NUMBER_INPUT_TIMEOUT_MS = 1200;
const EPG_POLL_INTERVAL_MS = 60000;
const UI_AUTO_HIDE_TIMEOUT_MS = 10000;
const PLAYER_INPUT_GUARD_MS = 900;
const MENU_CHANNEL_ITEM_HEIGHT_PX = 62;
const GUIDE_VISIBLE_ROWS = 10;
const GUIDE_TIMELINE_STEP_MS = 30 * 60 * 1000;
const GUIDE_TIMELINE_WINDOW_MS = 2 * 60 * 60 * 1000;

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

  if (
    key === 'list' ||
    key === 'channellist' ||
    key === 'livetv' ||
    key === 'tvlist' ||
    key === 'channels'
  ) {
    return { action: 'LIST' };
  }
  if (code === 10073 || code === 170) {
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
  const [apiBase, setApiBase] = useState<string>(() => getInitialApiBase());
  const [view, setView] = useState<ScreenView>(() => (getStorageValue(DEVICE_TOKEN_KEY)?.trim() ? 'player' : 'pairing'));
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  const [pairingCode, setPairingCode] = useState<string>();
  const [pairingUrl, setPairingUrl] = useState<string>();
  const [deviceMacAddress, setDeviceMacAddress] = useState<string>();
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const guidePreviewVideoRef = useRef<HTMLVideoElement>(null);
  const channelNumberTimerRef = useRef<number>();
  const uiAutoHideTimerRef = useRef<number>();
  const playerInputGuardUntilRef = useRef(0);
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
      const maxStartIndex = Math.max(total - GUIDE_VISIBLE_ROWS, 0);
      const safeStart = Math.min(Math.max(guideListStartIndex, 0), maxStartIndex);
      return {
        start: safeStart,
        end: Math.min(safeStart + GUIDE_VISIBLE_ROWS, total)
      };
    },
    [channels.length, guideListStartIndex]
  );
  const visibleGuideChannels = useMemo(
    () => channels.slice(guideWindowRange.start, guideWindowRange.end),
    [channels, guideWindowRange.end, guideWindowRange.start]
  );
  const playingChannelLogo = playingChannelNowNext?.channelLogo ?? playingChannel?.logo;
  const normalizedPlayingChannelLogo = typeof playingChannelLogo === 'string' ? playingChannelLogo.trim() : '';
  const shouldShowPlayingChannelLogo = normalizedPlayingChannelLogo.length > 0 && !logoLoadFailed;
  const currentPlaybackUrl = useMemo(() => {
    if (!playingChannel) {
      return '';
    }
    if (playbackOverride && playbackOverride.channelId === playingChannel.id) {
      return playbackOverride.url;
    }
    return playingChannel.url;
  }, [playbackOverride, playingChannel]);

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
    }, UI_AUTO_HIDE_TIMEOUT_MS);
  }, [clearChannelNumberTimer, clearUiAutoHideTimer]);

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
    setPlaybackOverride(undefined);
    setPlayingChannelId(channelId);
  }, []);

  const playArchiveChannelById = useCallback((channelId: string, archiveUrl: string, label: string): void => {
    setAudioOnlyWarning(undefined);
    setPlaybackOverride({
      channelId,
      url: archiveUrl,
      label
    });
    setPlayingChannelId(channelId);
  }, []);

  const openChannelList = useCallback(
    (_focusZone: MenuFocusZone = 'channels', nextMenuView: MenuView = 'epg') => {
      registerPlayerActivity();
      setMenuView(nextMenuView === 'epg' ? 'epg' : 'epg');
      setMenuFocusZone('channels');
      setShowChannelList(true);
      const currentPlayingId = playingChannelId ?? channels[0]?.id;
      const guideIndex = currentPlayingId ? channels.findIndex((channel) => channel.id === currentPlayingId) : -1;
      const nextGuideIndex = guideIndex >= 0 ? guideIndex : 0;
      const maxStartIndex = Math.max(channels.length - GUIDE_VISIBLE_ROWS, 0);
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
    [channels, clearChannelNumberInput, playingChannelId, registerPlayerActivity]
  );

  const closeChannelList = useCallback(() => {
    registerPlayerActivity();
    setShowChannelList(false);
    setMenuView('epg');
    setMenuFocusZone('channels');
    clearChannelNumberInput();
  }, [clearChannelNumberInput, registerPlayerActivity]);

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

  const restoreTokenByMacAddress = useCallback(
    async (macAddress?: string): Promise<{ deviceToken?: string; deviceName?: string; resolvedBase?: string }> => {
      const normalizedMac = (macAddress ?? '').trim();
      const candidates = buildApiBaseCandidates(apiBase);

      for (const candidateBase of candidates) {
        try {
          const restoreUrl = normalizedMac
            ? `${candidateBase}/devices/webos/restore-token?mac=${encodeURIComponent(normalizedMac)}`
            : `${candidateBase}/devices/webos/restore-token`;
          const response = await fetchJson<WebOsRestoreResponse>(
            restoreUrl
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
    [apiBase]
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
      setPlaybackOverride(undefined);
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
      loadDayGridForToken(token, getLocalDateKey(new Date())).catch(() => {
        // Keep playback active if day EPG fails.
      });
    },
    [apiBase, clearChannelNumberInput, loadDayGridForToken, loadNowNextForToken]
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
    setPlaybackOverride(undefined);
    const macAddress = await requestWebOsMacAddress();
    setDeviceMacAddress(macAddress);
    const deviceName = macAddress ? `LG webOS TV [${macAddress}]` : 'LG webOS TV';

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
      macAddress
        ? `Scan QR and confirm pair in web-admin. MAC: ${macAddress}`
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
  }, [apiBase, clearEpgPolling, clearPairPolling, loadPlaylist]);

  const logoutDevice = useCallback(() => {
    clearPairPolling();
    clearEpgPolling();
    removeStorageValue(DEVICE_TOKEN_KEY);
    removeStorageValue(LAST_PLAYING_CHANNEL_ID_KEY);
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
    channelNumberInputRef.current = '';
    clearChannelNumberTimer();
    setAudioOnlyWarning(undefined);
    setPairingCode(undefined);
    setPairingUrl(undefined);
    setView('pairing');
    setStatusMessage('Disconnected. Generating a new QR...');
    setErrorMessage(undefined);
    startPairing().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : FETCH_ERROR_MESSAGE;
      setErrorMessage(message);
    });
  }, [clearChannelNumberTimer, clearEpgPolling, clearPairPolling, startPairing]);

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

    const maxStartIndex = Math.max(channels.length - GUIDE_VISIBLE_ROWS, 0);
    setGuideListStartIndex((currentStart) => {
      let nextStart = Math.min(Math.max(currentStart, 0), maxStartIndex);
      if (guideSelectedIndex < nextStart) {
        nextStart = guideSelectedIndex;
      } else if (guideSelectedIndex >= nextStart + GUIDE_VISIBLE_ROWS) {
        nextStart = guideSelectedIndex - GUIDE_VISIBLE_ROWS + 1;
      }
      return Math.min(Math.max(nextStart, 0), maxStartIndex);
    });
  }, [channels.length, guideSelectedIndex, showChannelList]);

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

      const macAddress = await requestWebOsMacAddress();
      if (macAddress) {
        setDeviceMacAddress(macAddress);
      }
      setStatusMessage('Restoring TV from database...');

      const restored = await restoreTokenByMacAddress(macAddress);
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
  }, [apiBase, loadPlaylist, probeStoredDeviceToken, restoreTokenByMacAddress, startPairing]);

  useEffect(() => {
    if (view !== 'player' || !playingChannel || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    const playbackUrl =
      playbackOverride && playbackOverride.channelId === playingChannel.id
        ? playbackOverride.url
        : playingChannel.url;
    setAudioOnlyWarning(undefined);
    video.muted = isMuted;
    video.src = playbackUrl;
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
  }, [isMuted, playbackOverride, playingChannel, view]);

  useEffect(() => {
    const previewVideo = guidePreviewVideoRef.current;
    if (!previewVideo) {
      return;
    }

    if (view !== 'player' || !showChannelList) {
      previewVideo.pause();
      previewVideo.removeAttribute('src');
      previewVideo.srcObject = null;
      previewVideo.load();
      return;
    }

    previewVideo.muted = true;
    previewVideo.defaultMuted = true;
    previewVideo.playsInline = true;

    const mainVideo = videoRef.current as (HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    }) | null;
    const capture = mainVideo?.captureStream ?? mainVideo?.mozCaptureStream;
    let attachedCaptureStream = false;

    if (capture) {
      try {
        const stream = capture.call(mainVideo);
        if (stream) {
          if (previewVideo.srcObject !== stream) {
            previewVideo.srcObject = stream;
          }
          attachedCaptureStream = true;
        }
      } catch {
        attachedCaptureStream = false;
      }
    }

    if (!attachedCaptureStream) {
      if (previewVideo.srcObject) {
        previewVideo.srcObject = null;
      }
      if (currentPlaybackUrl) {
        const currentSrc = previewVideo.currentSrc || previewVideo.src;
        if (currentSrc !== currentPlaybackUrl) {
          previewVideo.src = currentPlaybackUrl;
          previewVideo.load();
        }
      }
    }

    previewVideo.play().catch(() => {
      // Ignore preview autoplay errors.
    });
  }, [currentPlaybackUrl, showChannelList, view]);

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
    }, EPG_POLL_INTERVAL_MS);

    return () => {
      clearEpgPolling();
    };
  }, [clearEpgPolling, deviceToken, loadNowNextForToken, view]);

  useEffect(() => {
    if (view !== 'player' || !deviceToken || !showChannelList || menuView !== 'epg') {
      return;
    }

    const refreshDay = (): void => {
      const targetDayKey = getLocalDateKey(new Date());
      const stale = Date.now() - epgDayRefreshRef.current > 120_000;
      if (targetDayKey !== epgDayDate || stale) {
        loadDayGridForToken(deviceToken, targetDayKey).catch(() => {
          // Keep the guide open even if a provider is temporarily unavailable.
        });
      }
    };

    refreshDay();
    const intervalId = window.setInterval(refreshDay, 120_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [deviceToken, epgDayDate, loadDayGridForToken, menuView, showChannelList, view]);

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

      if (action === 'LIST' || action === 'GUIDE' || action === 'INFO' || action === 'MENU') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
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
          (action === 'ENTER' ||
            action === 'LIST' ||
            action === 'GUIDE' ||
            action === 'INFO' ||
            action === 'MENU' ||
            action === 'RED' ||
            action === 'BLUE')
        ) {
          event.preventDefault();
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
          stepGuideTimeline(-1);
          return;
        }

        if (action === 'RIGHT') {
          event.preventDefault();
          stepGuideTimeline(1);
          return;
        }

        if (action === 'ENTER') {
          event.preventDefault();
          const guideChannel = channels[guideSelectedIndex];
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
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    channels,
    clearChannelNumberInput,
    closeChannelList,
    getGuideProgramForChannelAtFocus,
    guideSelectedIndex,
    openChannelList,
    playArchiveChannelById,
    playCurrentVideo,
    playLiveChannelById,
    pushChannelNumberDigit,
    registerPlayerActivity,
    showChannelList,
    startPairing,
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
  const guideDayLabel = new Date(guideFocusTimeMs).toLocaleDateString('ro-RO', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit'
  });
  const guideHeaderDateTime = new Date(nowMs).toLocaleString('ro-RO', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const focusedProgramGenre = inferProgramGenre(focusedGuideProgram);
  const focusedProgramTitle = focusedGuideProgram?.title ?? 'EPG indisponibil';
  const focusedProgramDescription =
    focusedGuideProgram?.description?.trim() || 'Nu exista descriere pentru acest program.';
  const focusedProgramEndMs = parseProgramTimestamp(focusedGuideProgram?.end);
  const selectedGuideArchiveDays = resolveArchiveDays(selectedGuideChannel);
  const canPlayFocusedArchive =
    Boolean(focusedGuideProgram) &&
    typeof focusedProgramEndMs === 'number' &&
    focusedProgramEndMs <= nowMs &&
    selectedGuideArchiveDays > 0;
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
    <div className={isUiVisible && showChannelList ? 'player is-menu-open' : 'player'}>
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
              {playbackOverride ? <p className="screen__hint">Arhiva activa: {playbackOverride.label}</p> : null}
              {channels.length === 0 ? <p className="msg msg--ok screen__msg">Player pornit. Nu exista inca canale alocate.</p> : null}
            </div>
          </>
        ) : null}
      </main>

      {isUiVisible && showChannelList ? (
        <aside className="epgx-guide">
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

          <section className="epgx-guide__hero">
            <div className="epgx-guide__preview">
              <video ref={guidePreviewVideoRef} className="epgx-guide__preview-video" playsInline muted />
            </div>
            <div className="epgx-guide__hero-info">
              <p className="epgx-guide__hero-channel">
                #{guideSelectedIndex + 1} {selectedGuideChannel?.name ?? 'Canal'}
              </p>
              <p className="epgx-guide__hero-title">{focusedProgramTitle}</p>
              <p className="epgx-guide__hero-time">{formatProgramRange(focusedGuideProgram)}</p>
            </div>
          </section>

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
                    const widthPct = Math.max(((clippedEndMs - clippedStartMs) / GUIDE_TIMELINE_WINDOW_MS) * 100, 4);
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
                          <img className="epgx-guide__row-logo" src={normalizedRowLogo} alt={`${channel.name} logo`} />
                        ) : (
                          <span className="epgx-guide__row-logo-fallback">
                            {(channel.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="epgx-guide__row-name">{channel.name || `Canal ${index + 1}`}</span>

                    <span className="epgx-guide__row-timeline">
                      {guideTickMarks.slice(1, -1).map((tick) => (
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
                              <span className="epgx-guide__program-time">{formatProgramRange(block.program)}</span>
                              {block.canArchive ? <span className="epgx-guide__program-archive">ARHIVA</span> : null}
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

          <footer className="epgx-guide__details">
            <div className="epgx-guide__details-main">
              <p className="epgx-guide__details-title">{focusedProgramTitle}</p>
              <p className="epgx-guide__details-time">{formatProgramRange(focusedGuideProgram)}</p>
              <p className="epgx-guide__details-description">{focusedProgramDescription}</p>
            </div>
            <div className="epgx-guide__details-chips">
              <span className="epgx-guide__chip">
                <strong>{focusedProgramGenre.icon}</strong>
                {focusedProgramGenre.label}
              </span>
              <span className="epgx-guide__chip">Canal #{guideSelectedIndex + 1}</span>
              <span className={canPlayFocusedArchive ? 'epgx-guide__chip is-accent' : 'epgx-guide__chip'}>
                {canPlayFocusedArchive ? `Arhiva ${selectedGuideArchiveDays} zile` : 'Arhiva indisponibila'}
              </span>
              <span className="epgx-guide__chip">Favorite</span>
              <span className="epgx-guide__chip">Reminder</span>
              <span className="epgx-guide__chip">{guideDayLabel}</span>
            </div>
            <p className="epgx-guide__controls">
              Sus/Jos canale | Stanga/Dreapta timp si arhiva | OK reda canalul sau arhiva | Back inchide guide
            </p>
          </footer>
        </aside>
      ) : null}
    </div>
  );
};


