import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Channel {
  id: string;
  name: string;
  url: string;
  logo?: string;
  tvgId?: string;
  group?: string;
  groupName?: string;
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

type ScreenView = 'pairing' | 'player';
type MenuFocusZone = 'categories' | 'channels';
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
const LAN_FALLBACK_API_BASE = import.meta.env.VITE_API_BASE_FALLBACK_URL ?? 'http://10.0.0.247:3000';
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? LAN_FALLBACK_API_BASE;
const OVERRIDE_WEB_ADMIN_BASE = import.meta.env.VITE_WEB_ADMIN_URL;
const REQUEST_TIMEOUT_MS = 9000;
const FETCH_ERROR_MESSAGE = 'failed to fetch';

const AUDIO_ONLY_DETECT_MS = 2500;
const CHANNEL_NUMBER_INPUT_TIMEOUT_MS = 1200;
const EPG_POLL_INTERVAL_MS = 60000;

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');
const getChannelGroupName = (channel: Channel): string => normalizeGroupName(channel.groupName ?? channel.group);
const normalizeGroupName = (value?: string): string => {
  const normalized = (value ?? '').trim();
  return normalized || 'Fara categorie';
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

  if (key === 'list' || key === 'channellist' || key === 'livetv') {
    return { action: 'LIST' };
  }
  if (key === 'guide' || code === 458) {
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

const getInitialApiBase = (): string => {
  const fallback = normalizeBaseUrl(DEFAULT_API_BASE);
  const stored = getStorageValue(API_BASE_KEY);
  if (!stored) {
    return fallback;
  }

  const normalized = normalizeBaseUrl(stored);
  if (!normalized) {
    return fallback;
  }

  // webOS app runs on TV, so localhost usually points to TV itself, not backend PC.
  if (normalized.includes('://localhost') || normalized.includes('://127.0.0.1')) {
    return fallback;
  }

  return normalized;
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
  const [view, setView] = useState<ScreenView>('pairing');
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();

  const [pairingCode, setPairingCode] = useState<string>();
  const [pairingUrl, setPairingUrl] = useState<string>();
  const [deviceMacAddress, setDeviceMacAddress] = useState<string>();
  const [deviceToken, setDeviceToken] = useState<string>();
  const pairPollingRef = useRef<number>();
  const epgPollingRef = useRef<number>();
  const pairPollFailureCountRef = useRef(0);
  const startPairingRequestRef = useRef(0);
  const bootstrappedRef = useRef(false);

  const [channels, setChannels] = useState<Channel[]>([]);
  const [epgNowNextByChannelId, setEpgNowNextByChannelId] = useState<Record<string, EpgNowNextItem>>({});
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playingChannelId, setPlayingChannelId] = useState<string>();
  const [showChannelList, setShowChannelList] = useState(true);
  const [menuFocusZone, setMenuFocusZone] = useState<MenuFocusZone>('channels');
  const [channelNumberInput, setChannelNumberInput] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [audioOnlyWarning, setAudioOnlyWarning] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const channelNumberTimerRef = useRef<number>();
  const channelNumberInputRef = useRef('');
  const categoryButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const channelButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
  const playingChannelNowNext = useMemo(() => {
    if (!playingChannel) {
      return undefined;
    }

    const direct = epgNowNextByChannelId[playingChannel.id];
    if (direct) {
      return direct;
    }

    if (!playingChannel.tvgId) {
      return undefined;
    }

    return Object.values(epgNowNextByChannelId).find((item) => item.channelTvgId === playingChannel.tvgId);
  }, [epgNowNextByChannelId, playingChannel]);
  const playingNowProgram = playingChannelNowNext?.now;
  const playingNextProgram = playingChannelNowNext?.next;
  const playingChannelLogo = playingChannelNowNext?.channelLogo ?? playingChannel?.logo;

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

  const clearChannelNumberInput = useCallback(() => {
    clearChannelNumberTimer();
    channelNumberInputRef.current = '';
    setChannelNumberInput('');
  }, [clearChannelNumberTimer]);

  const focusPlayingChannelInList = useCallback(() => {
    const currentPlayingId = playingChannelId ?? channels[0]?.id;
    if (!currentPlayingId) {
      return;
    }

    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      const channelIndex = categories[categoryIndex].channels.findIndex((channel) => channel.id === currentPlayingId);
      if (channelIndex >= 0) {
        setSelectedCategoryIndex(categoryIndex);
        setSelectedIndex(channelIndex);
        return;
      }
    }
  }, [categories, channels, playingChannelId]);

  const openChannelList = useCallback(
    (focusZone: MenuFocusZone = 'channels') => {
      setMenuFocusZone(focusZone);
      setShowChannelList(true);
      focusPlayingChannelInList();
      clearChannelNumberInput();
    },
    [clearChannelNumberInput, focusPlayingChannelInList]
  );

  const closeChannelList = useCallback(() => {
    setShowChannelList(false);
    setMenuFocusZone('channels');
    clearChannelNumberInput();
  }, [clearChannelNumberInput]);

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
        setAudioOnlyWarning(undefined);
        setPlayingChannelId(channel.id);
      }
    },
    [categoryChannels]
  );

  const stepChannelAndPlay = useCallback(
    (delta: number) => {
      setSelectedIndex((prev) => {
        if (!categoryChannels.length) {
          return prev;
        }

        const next = wrapIndex(prev + delta, categoryChannels.length);
        const channel = categoryChannels[next];
        if (channel) {
          setAudioOnlyWarning(undefined);
          setPlayingChannelId(channel.id);
        }
        return next;
      });
    },
    [categoryChannels]
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
      if (!categoryChannels.length) {
        return;
      }
      if (parsed > categoryChannels.length) {
        setStatusMessage(`Canalul ${parsed} nu exista in categoria ${selectedCategory?.name ?? '-'}.`);
        return;
      }

      const index = parsed - 1;
      const channel = categoryChannels[index];
      if (!channel) {
        return;
      }

      setSelectedIndex(index);
      setAudioOnlyWarning(undefined);
      setPlayingChannelId(channel.id);
      setShowChannelList(false);
      setStatusMessage(`Canal ${parsed}: ${channel.name}`);
    },
    [categoryChannels, clearChannelNumberInput, selectedCategory?.name]
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
      const fallbackBase = normalizeBaseUrl(LAN_FALLBACK_API_BASE);
      const candidates = [normalizeBaseUrl(apiBase)].filter(Boolean);
      if (!candidates.includes(fallbackBase)) {
        candidates.push(fallbackBase);
      }

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

  const loadNowNextForToken = useCallback(
    async (token: string): Promise<void> => {
      const normalizedToken = token.trim();
      if (!normalizedToken) {
        setEpgNowNextByChannelId({});
        return;
      }

      const fallbackBase = normalizeBaseUrl(LAN_FALLBACK_API_BASE);
      const candidates = [normalizeBaseUrl(apiBase)].filter(Boolean);
      if (!candidates.includes(fallbackBase)) {
        candidates.push(fallbackBase);
      }

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

  const loadPlaylist = useCallback(
    async (token: string) => {
      const fallbackBase = normalizeBaseUrl(LAN_FALLBACK_API_BASE);
      const candidates = [normalizeBaseUrl(apiBase)].filter(Boolean);
      if (!candidates.includes(fallbackBase)) {
        candidates.push(fallbackBase);
      }

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

      if (usedBase !== apiBase) {
        setApiBase(usedBase);
        setStorageValue(API_BASE_KEY, usedBase);
      }

      setStorageValue(DEVICE_TOKEN_KEY, token);
      setDeviceToken(token);
      setChannels(resolvedChannels);
      setEpgNowNextByChannelId({});
      setSelectedCategoryIndex(0);
      setSelectedIndex(0);
      setPlayingChannelId(resolvedChannels[0]?.id);
      setShowChannelList(true);
      setMenuFocusZone('channels');
      setAudioOnlyWarning(undefined);
      clearChannelNumberInput();
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
    },
    [apiBase, clearChannelNumberInput, loadNowNextForToken]
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
    const macAddress = await requestWebOsMacAddress();
    setDeviceMacAddress(macAddress);
    const deviceName = macAddress ? `LG webOS TV [${macAddress}]` : 'LG webOS TV';

    const fallbackBase = normalizeBaseUrl(LAN_FALLBACK_API_BASE);
    const candidates = [normalizeBaseUrl(apiBase)].filter(Boolean);
    if (!candidates.includes(fallbackBase)) {
      candidates.push(fallbackBase);
    }

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
      throw lastError instanceof Error ? lastError : new Error(FETCH_ERROR_MESSAGE);
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
    setDeviceToken(undefined);
    setChannels([]);
    setEpgNowNextByChannelId({});
    setSelectedCategoryIndex(0);
    setSelectedIndex(0);
    setPlayingChannelId(undefined);
    setShowChannelList(true);
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
          // keep token in storage; retry with pairing only if playback cannot be restored now
        }
      }

      setView('pairing');
      await startPairing();
    };

    restoreOrPair().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : FETCH_ERROR_MESSAGE;
      setErrorMessage(message);
    });
  }, [apiBase, loadPlaylist, probeStoredDeviceToken, startPairing]);

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
    }, EPG_POLL_INTERVAL_MS);

    return () => {
      clearEpgPolling();
    };
  }, [clearEpgPolling, deviceToken, loadNowNextForToken, view]);

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

      if (view === 'player') {
        if (action === 'DIGIT' && Number.isFinite(digit)) {
          event.preventDefault();
          pushChannelNumberDigit(digit as number);
          return;
        }

        if (action === 'LIST' || action === 'GUIDE' || action === 'INFO' || action === 'MENU' || action === 'RED') {
          event.preventDefault();
          openChannelList(action === 'GUIDE' ? 'categories' : 'channels');
          return;
        }

        if (action === 'GREEN') {
          event.preventDefault();
          openChannelList('categories');
          stepCategory(1);
          return;
        }

        if (action === 'YELLOW') {
          event.preventDefault();
          openChannelList('categories');
          stepCategory(-1);
          return;
        }

        if (action === 'MUTE' || action === 'BLUE') {
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
          openChannelList('channels');
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
            return;
          }
          logoutDevice();
          return;
        }

        if (!categoryChannels.length) {
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

        if (!showChannelList && action === 'ENTER') {
          event.preventDefault();
          openChannelList('channels');
          return;
        }

        if (!showChannelList) {
          return;
        }

        if (menuFocusZone === 'categories') {
          if (action === 'UP') {
            event.preventDefault();
            stepCategory(-1);
            return;
          }
          if (action === 'DOWN') {
            event.preventDefault();
            stepCategory(1);
            return;
          }
          if (action === 'RIGHT' || action === 'ENTER') {
            event.preventDefault();
            setMenuFocusZone('channels');
            clearChannelNumberInput();
            return;
          }
          if (action === 'LEFT') {
            event.preventDefault();
            closeChannelList();
            return;
          }
          return;
        }

        if (action === 'UP') {
          event.preventDefault();
          selectChannelAtIndex(wrapIndex(selectedIndex - 1, categoryChannels.length), false);
          clearChannelNumberInput();
          return;
        }

        if (action === 'DOWN') {
          event.preventDefault();
          selectChannelAtIndex(wrapIndex(selectedIndex + 1, categoryChannels.length), false);
          clearChannelNumberInput();
          return;
        }

        if (action === 'LEFT') {
          event.preventDefault();
          setMenuFocusZone('categories');
          clearChannelNumberInput();
          return;
        }

        if (action === 'ENTER') {
          event.preventDefault();
          if (selectedChannel) {
            setAudioOnlyWarning(undefined);
            setPlayingChannelId(selectedChannel.id);
            closeChannelList();
            clearChannelNumberInput();
            setStatusMessage(`Playing: ${selectedChannel.name}`);
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

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    categoryChannels.length,
    clearChannelNumberInput,
    closeChannelList,
    logoutDevice,
    menuFocusZone,
    openChannelList,
    playCurrentVideo,
    pushChannelNumberDigit,
    selectedChannel,
    selectedIndex,
    showChannelList,
    selectChannelAtIndex,
    startPairing,
    stepCategory,
    stepChannelAndPlay,
    togglePlayPause,
    view
  ]);

  useEffect(() => {
    if (!showChannelList) {
      clearChannelNumberInput();
    }
  }, [clearChannelNumberInput, showChannelList]);

  useEffect(() => {
    if (!showChannelList || categories.length === 0) {
      return;
    }

    const safeIndex = Math.min(Math.max(selectedCategoryIndex, 0), categories.length - 1);
    categoryButtonRefs.current[safeIndex]?.scrollIntoView({
      block: 'nearest'
    });
  }, [categories.length, selectedCategoryIndex, showChannelList]);

  useEffect(() => {
    if (!showChannelList || categoryChannels.length === 0) {
      return;
    }

    const safeIndex = Math.min(Math.max(selectedIndex, 0), categoryChannels.length - 1);
    channelButtonRefs.current[safeIndex]?.scrollIntoView({
      block: 'nearest'
    });
  }, [categoryChannels, selectedIndex, showChannelList]);

  useEffect(() => {
    return () => {
      clearChannelNumberInput();
      clearPairPolling();
      clearEpgPolling();
    };
  }, [clearChannelNumberInput, clearEpgPolling, clearPairPolling]);

  const pairingQrImageUrl = pairingUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(pairingUrl)}`
    : undefined;

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
    <div className={showChannelList ? 'player is-menu-open' : 'player'}>
      <main className="screen">
        <video ref={videoRef} className="video" playsInline />

        {!showChannelList ? (
          <>
            <div className="screen__overlay screen__overlay--top">
              <div className="screen__chip-group">
                <span className="screen__chip screen__chip--title">
                  {playingChannel?.name || (channels.length === 0 ? 'Device paired' : 'No channel selected')}
                </span>
                <span className="screen__chip">
                  {selectedCategory?.name ?? 'Fara categorie'} | {categoryChannels.length ? selectedIndex + 1 : 0}/{categoryChannels.length}
                </span>
                <span className={isMuted ? 'screen__chip screen__chip--warn' : 'screen__chip'}>
                  {isMuted ? 'MUTE ON' : 'MUTE OFF'}
                </span>
                {channelNumberInput ? <span className="screen__chip screen__chip--number">#{channelNumberInput}</span> : null}
              </div>
            </div>

            <div className="screen__overlay screen__overlay--bottom">
              <div className="screen__channel-info">
                {playingChannelLogo ? (
                  <img className="screen__channel-logo" src={playingChannelLogo} alt={`${playingChannel?.name ?? 'Channel'} logo`} />
                ) : (
                  <div className="screen__channel-logo screen__channel-logo--fallback">
                    {(playingChannel?.name ?? '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="screen__channel-info-meta">
                  <p className="screen__channel-info-name">
                    {playingChannel?.name || (channels.length === 0 ? 'Player activ' : 'Canal neselectat')}
                  </p>
                  <p className="screen__channel-epg-line">
                    <span className="screen__channel-epg-label">Acum</span>
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
                  : 'CH+/CH- sau UP/DOWN canal | OK/LIST meniu | PLAY/PAUSE control'}
              </p>
              {audioOnlyWarning ? <p className="msg msg--error screen__msg">{audioOnlyWarning}</p> : null}
              {errorMessage ? <p className="msg msg--error screen__msg">{errorMessage}</p> : null}
              {channels.length === 0 ? <p className="msg msg--ok screen__msg">Player pornit. Nu exista inca canale alocate.</p> : null}
            </div>
          </>
        ) : null}
      </main>

      {showChannelList ? (
        <aside className="mx-menu">
          <div className="mx-menu__columns">
            <section
              className={
                menuFocusZone === 'channels'
                  ? 'mx-panel mx-panel--channels is-focused'
                  : 'mx-panel mx-panel--channels'
              }
            >
              <p className="mx-panel__title">Canale</p>
              <div className="mx-panel__list">
                {categoryChannels.length === 0 ? (
                  <p className="mx-empty">Nu exista canale in aceasta categorie.</p>
                ) : (
                  categoryChannels.map((channel, index) => {
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        ref={(element) => {
                          channelButtonRefs.current[index] = element;
                        }}
                        className={index === selectedIndex ? 'mx-channel is-active' : 'mx-channel'}
                        onClick={() => {
                          selectChannelAtIndex(index, true);
                          closeChannelList();
                          setStatusMessage(`Playing: ${channel.name}`);
                        }}
                      >
                        <span className="mx-channel__name">{channel.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            <section
              className={
                menuFocusZone === 'categories'
                  ? 'mx-panel mx-panel--categories is-focused'
                  : 'mx-panel mx-panel--categories'
              }
            >
              <p className="mx-panel__title">Categorii</p>
              <div className="mx-panel__list">
                {categories.map((category, index) => (
                  <button
                    key={category.name}
                    type="button"
                    ref={(element) => {
                      categoryButtonRefs.current[index] = element;
                    }}
                    className={index === selectedCategoryIndex ? 'mx-category is-active' : 'mx-category'}
                    onClick={() => {
                      setSelectedCategoryIndex(index);
                      setSelectedIndex(0);
                      setMenuFocusZone('channels');
                      clearChannelNumberInput();
                    }}
                  >
                    <span>{category.name}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </aside>
      ) : null}
    </div>
  );
};
