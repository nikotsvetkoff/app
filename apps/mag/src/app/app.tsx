import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Channel {
  id: string;
  name: string;
  url: string;
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

interface SettingOption {
  id: string;
  label: string;
  values: string[];
  help: string;
  defaultIndex?: number;
}

type ScreenView = 'menu' | 'pairing' | 'token' | 'settings' | 'player';
type RemoteAction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'ENTER' | 'BACK' | 'MENU' | 'NONE';

const DEVICE_TOKEN_KEY = 'iptv:mag:deviceToken';
const API_BASE_KEY = 'iptv:mag:apiBase';
const LAN_FALLBACK_API_BASE = import.meta.env.VITE_API_BASE_FALLBACK_URL ?? 'http://10.0.0.246:3000';
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? LAN_FALLBACK_API_BASE;
const OVERRIDE_WEB_ADMIN_BASE = import.meta.env.VITE_WEB_ADMIN_URL;
const REQUEST_TIMEOUT_MS = 9000;

const TOKEN_ITEM_COUNT = 3;
const LIST_VISIBLE_COUNT = 10;
const SETTINGS_VISIBLE_COUNT = 10;
const AUDIO_ONLY_DETECT_MS = 2500;

const SETTINGS_OPTIONS: SettingOption[] = [
  {
    id: 'language',
    label: 'Limba interfata',
    values: ['Romana', 'Rusa', 'Engleza'],
    help: 'Schimba limba meniurilor si a textelor din aplicatie.',
    defaultIndex: 0
  },
  {
    id: 'resume',
    label: 'Reia ultima stare',
    values: ['Pornit', 'Oprit'],
    help: 'Revine la ultimul canal sau la ultima categorie folosita.',
    defaultIndex: 0
  },
  {
    id: 'navigation',
    label: 'Tip navigare',
    values: ['Lista', 'Grid', 'Mixt'],
    help: 'Alege stilul principal de navigare pentru canale.',
    defaultIndex: 0
  },
  {
    id: 'groupOrder',
    label: 'Ordine grupuri',
    values: ['Incarcare', 'Alfabetic'],
    help: 'Stabileste ordinea in care apar categoriile de canale.',
    defaultIndex: 0
  },
  {
    id: 'playMode',
    label: 'Mod redare',
    values: ['Secvential', 'Loop'],
    help: 'Controleaza ce se intampla dupa finalul unui stream.',
    defaultIndex: 0
  },
  {
    id: 'videoEngine',
    label: 'Motor video',
    values: ['HTML5', 'Native'],
    help: 'Pentru MAG250 recomandat este HTML5 pentru compatibilitate.',
    defaultIndex: 0
  },
  {
    id: 'hlsProfile',
    label: 'Profil HLS',
    values: ['Default', 'Compat', 'Low latency'],
    help: 'Schimba profilul pentru streamuri HLS instabile.',
    defaultIndex: 0
  },
  {
    id: 'theme',
    label: 'Tema culoare',
    values: ['Blue', 'Dark', 'Ocean'],
    help: 'Seteaza schema vizuala a aplicatiei.',
    defaultIndex: 0
  },
  {
    id: 'uiScale',
    label: 'Marime elemente',
    values: ['Normala', 'Mare'],
    help: 'Creste dimensiunea textelor si a elementelor pentru TV.',
    defaultIndex: 0
  },
  {
    id: 'clock',
    label: 'Ceas in player',
    values: ['Pornit', 'Oprit'],
    help: 'Afiseaza ora curenta in bara playerului.',
    defaultIndex: 1
  },
  {
    id: 'udpProxy',
    label: 'UDP proxy',
    values: ['Oprit', 'Pornit'],
    help: 'Activeaza proxy UDP daca furnizorul IPTV cere acest mod.',
    defaultIndex: 0
  },
  {
    id: 'reset',
    label: 'Reset setari',
    values: ['Nu', 'Da'],
    help: 'Reseteaza valorile locale ale aplicatiei la default.',
    defaultIndex: 0
  }
];

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');
const getChannelGroupName = (channel: Channel): string => normalizeGroupName(channel.groupName ?? channel.group);
const normalizeGroupName = (value?: string): string => {
  const normalized = (value ?? '').trim();
  return normalized || 'Fara categorie';
};

const wrapIndex = (next: number, length: number): number => {
  if (length <= 0) {
    return 0;
  }

  return (next % length + length) % length;
};

const formatSettingsClock = (): string => {
  const now = new Date();
  const dateText = new Intl.DateTimeFormat('ro-RO', {
    weekday: 'long',
    day: '2-digit',
    month: 'long'
  }).format(now);
  const timeText = now.toLocaleTimeString('ro-RO', { hour12: false });
  return `${dateText}    ${timeText}`;
};

const MAG250_KEYCODE_MAP: Record<number, RemoteAction> = {
  8: 'BACK',
  13: 'ENTER',
  27: 'BACK',
  33: 'UP',
  34: 'DOWN',
  37: 'LEFT',
  38: 'UP',
  39: 'RIGHT',
  40: 'DOWN',
  122: 'MENU',
  123: 'MENU'
};

const getRemoteAction = (event: KeyboardEvent): RemoteAction => {
  const key = (event.key || '').toLowerCase();
  const code = event.keyCode;

  if (code === 9) {
    // MAG docs: channel next/prev uses Tab / Shift+Tab.
    return event.shiftKey ? 'UP' : 'DOWN';
  }

  if (MAG250_KEYCODE_MAP[code]) {
    return MAG250_KEYCODE_MAP[code];
  }

  if (key === 'arrowup' || code === 38) {
    return 'UP';
  }
  if (key === 'arrowdown' || code === 40) {
    return 'DOWN';
  }
  if (key === 'arrowleft' || code === 37) {
    return 'LEFT';
  }
  if (key === 'arrowright' || code === 39) {
    return 'RIGHT';
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
    return 'ENTER';
  }
  if (
    key === 'backspace' ||
    key === 'escape' ||
    key === 'browserback' ||
    key === 'back' ||
    key === 'goback' ||
    code === 8 ||
    code === 27 ||
    code === 461
  ) {
    return 'BACK';
  }

  return 'NONE';
};

const isTextInputElement = (target: EventTarget | null): target is HTMLInputElement => {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }

  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
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

  // MAG app runs on STB, so localhost usually points to box itself, not backend PC.
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

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  let timeoutId: number | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error('Timeout: backend unreachable'));
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
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  })();

  try {
    return (await Promise.race([fetchPromise, timeoutPromise])) as T;
  } finally {
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId);
    }
  }
};

export const MagApp: React.FC = () => {
  const [apiBase, setApiBase] = useState<string>(() => getInitialApiBase());
  const [apiBaseInput, setApiBaseInput] = useState<string>(() => getInitialApiBase());
  const [view, setView] = useState<ScreenView>('menu');
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [tokenInput, setTokenInput] = useState('');

  const [menuIndex, setMenuIndex] = useState(0);
  const [tokenIndex, setTokenIndex] = useState(0);
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [settingsClock, setSettingsClock] = useState(() => formatSettingsClock());
  const [settingsValues, setSettingsValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(SETTINGS_OPTIONS.map((option) => [option.id, option.defaultIndex ?? 0]))
  );

  const [pairCode, setPairCode] = useState<string>();
  const [pairingUrl, setPairingUrl] = useState<string>();
  const pairPollingRef = useRef<number>();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playingChannelId, setPlayingChannelId] = useState<string>();
  const [showChannelList, setShowChannelList] = useState(true);
  const [audioOnlyWarning, setAudioOnlyWarning] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);

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

  const visibleWindow = useMemo(() => {
    if (!categoryChannels.length) {
      return { start: 0, end: 0 };
    }

    // Keep exactly 23 visible entries; scrolling starts at channel 24.
    const start = Math.max(0, selectedIndex - (LIST_VISIBLE_COUNT - 1));
    const end = Math.min(categoryChannels.length, start + LIST_VISIBLE_COUNT);

    return { start, end };
  }, [categoryChannels, selectedIndex]);

  const visibleChannels = useMemo(
    () => categoryChannels.slice(visibleWindow.start, visibleWindow.end),
    [categoryChannels, visibleWindow.end, visibleWindow.start]
  );

  const selectedSetting = SETTINGS_OPTIONS[settingsIndex] ?? SETTINGS_OPTIONS[0];
  const settingsVisibleWindow = useMemo(() => {
    if (!SETTINGS_OPTIONS.length) {
      return { start: 0, end: 0 };
    }

    const start = Math.max(0, settingsIndex - (SETTINGS_VISIBLE_COUNT - 1));
    const end = Math.min(SETTINGS_OPTIONS.length, start + SETTINGS_VISIBLE_COUNT);
    return { start, end };
  }, [settingsIndex]);
  const visibleSettings = useMemo(
    () => SETTINGS_OPTIONS.slice(settingsVisibleWindow.start, settingsVisibleWindow.end),
    [settingsVisibleWindow.end, settingsVisibleWindow.start]
  );
  const settingsScroll = useMemo(() => {
    const total = SETTINGS_OPTIONS.length;
    if (!total) {
      return { thumbHeight: 100, thumbTop: 0 };
    }

    const visibleCount = Math.min(total, SETTINGS_VISIBLE_COUNT);
    const thumbHeight = Math.max(12, (visibleCount / total) * 100);
    if (total <= visibleCount) {
      return { thumbHeight, thumbTop: 0 };
    }

    const maxTop = 100 - thumbHeight;
    const thumbTop = (settingsVisibleWindow.start / (total - visibleCount)) * maxTop;
    return { thumbHeight, thumbTop };
  }, [settingsVisibleWindow.start]);

  const clearPairPolling = useCallback(() => {
    if (pairPollingRef.current) {
      window.clearInterval(pairPollingRef.current);
      pairPollingRef.current = undefined;
    }
  }, []);

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

  const changeSettingValue = useCallback(
    (delta: number) => {
      const option = SETTINGS_OPTIONS[settingsIndex];
      if (!option || option.values.length <= 1) {
        return;
      }

      setSettingsValues((prev) => {
        const current = prev[option.id] ?? option.defaultIndex ?? 0;
        const next = wrapIndex(current + delta, option.values.length);
        return { ...prev, [option.id]: next };
      });
    },
    [settingsIndex]
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
        throw lastError instanceof Error ? lastError : new Error('Backend unreachable');
      }

      if (!response.channels || response.channels.length === 0) {
        throw new Error('No channels available for this token.');
      }

      if (usedBase !== apiBase) {
        setApiBase(usedBase);
        setApiBaseInput(usedBase);
        setStorageValue(API_BASE_KEY, usedBase);
      }

      setStorageValue(DEVICE_TOKEN_KEY, token);
      setChannels(response.channels);
      setSelectedCategoryIndex(0);
      setSelectedIndex(0);
      setPlayingChannelId(response.channels[0]?.id);
      setShowChannelList(true);
      setAudioOnlyWarning(undefined);
      setView('player');
      setErrorMessage(undefined);
      setStatusMessage(`Connected. Loaded ${response.channels.length} channels.`);
    },
    [apiBase]
  );

  const startPairing = useCallback(async () => {
    clearPairPolling();
    setView('pairing');
    setErrorMessage(undefined);
    setStatusMessage('Generating pairing code...');
    setPairCode(undefined);
    setPairingUrl(undefined);

    const started = await fetchJson<PairStartResponse>(`${apiBase}/devices/pair/start`, {
      method: 'POST',
      body: JSON.stringify({
        deviceName: 'MAG250 Linux Box',
        platform: 'mag'
      })
    });

    setPairCode(started.code);
    setPairingUrl(`${getWebAdminBase(apiBase)}/?pairCode=${encodeURIComponent(started.code)}`);
    setStatusMessage(
      `Pair code active until ${new Date(started.expiresAt).toLocaleTimeString()}. Confirm in web-admin.`
    );

    const intervalMs = Math.max(started.pollIntervalSec || 3, 2) * 1000;
    pairPollingRef.current = window.setInterval(() => {
      fetchJson<PairStatusResponse>(
        `${apiBase}/devices/pair/status?code=${encodeURIComponent(started.code)}`
      )
        .then((status) => {
          if (status.status === 'PAIRED' && status.deviceToken) {
            clearPairPolling();
            setPairCode(undefined);
            setPairingUrl(undefined);
            setStatusMessage('Pairing confirmed. Loading channels...');
            loadPlaylist(status.deviceToken).catch((err: unknown) => {
              const message = err instanceof Error ? err.message : 'Failed to load playlist.';
              setErrorMessage(message);
              setView('menu');
            });
            return;
          }

          if (status.status === 'EXPIRED') {
            clearPairPolling();
            setErrorMessage('Pair code expired. Start pairing again.');
            setView('menu');
          }
        })
        .catch((err: unknown) => {
          clearPairPolling();
          const message = err instanceof Error ? err.message : 'Pairing check failed.';
          setErrorMessage(message);
          setView('menu');
        });
    }, intervalMs);
  }, [apiBase, clearPairPolling, loadPlaylist]);

  const saveApiBase = useCallback(() => {
    const normalized = normalizeBaseUrl(apiBaseInput);
    if (!normalized) {
      setErrorMessage('Backend API URL invalid.');
      return;
    }

    setApiBase(normalized);
    setApiBaseInput(normalized);
    setStorageValue(API_BASE_KEY, normalized);
    setErrorMessage(undefined);
    setStatusMessage(`Backend API saved: ${normalized}`);
  }, [apiBaseInput]);

  const connectWithToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token) {
      setErrorMessage('Enter a valid device token.');
      return;
    }

    setErrorMessage(undefined);
    setStatusMessage('Connecting with token...');
    try {
      await loadPlaylist(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Token failed.';
      setStatusMessage(undefined);
      setErrorMessage(`Connect failed (${apiBase}): ${message}`);
      throw error;
    }
    setTokenInput('');
  }, [apiBase, loadPlaylist, tokenInput]);

  const logoutDevice = useCallback(() => {
    clearPairPolling();
    removeStorageValue(DEVICE_TOKEN_KEY);
    setChannels([]);
    setSelectedCategoryIndex(0);
    setSelectedIndex(0);
    setPlayingChannelId(undefined);
    setShowChannelList(true);
    setAudioOnlyWarning(undefined);
    setMenuIndex(0);
    setView('menu');
    setStatusMessage('Disconnected from device token.');
  }, [clearPairPolling]);

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
    const existingToken = getStorageValue(DEVICE_TOKEN_KEY);
    if (!existingToken) {
      return;
    }

    loadPlaylist(existingToken).catch((err: unknown) => {
      removeStorageValue(DEVICE_TOKEN_KEY);
      const message = err instanceof Error ? err.message : 'Saved token is invalid.';
      setErrorMessage(message);
      setView('menu');
    });
  }, [loadPlaylist]);

  useEffect(() => {
    if (view !== 'player' || !playingChannel || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    setAudioOnlyWarning(undefined);
    video.src = playingChannel.url;
    video.load();
    video.play().catch(() => {
      setErrorMessage('Could not start stream on this channel.');
    });

    const timer = window.setTimeout(() => {
      // If audio plays but videoWidth/videoHeight stay 0, the channel is usually audio-only
      // or encoded with unsupported video codec for this MAG browser.
      if (!video.paused && video.readyState >= 2 && (video.videoWidth === 0 || video.videoHeight === 0)) {
        setAudioOnlyWarning('Sunet fara imagine: codec video nesuportat pe acest TV pentru canalul selectat.');
      }
    }, AUDIO_ONLY_DETECT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [playingChannel, view]);

  useEffect(() => {
    if (view !== 'settings') {
      return;
    }

    setSettingsClock(formatSettingsClock());
    const timer = window.setInterval(() => {
      setSettingsClock(formatSettingsClock());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [view]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = getRemoteAction(event);
      if (action === 'NONE') {
        return;
      }

      const inputTarget = isTextInputElement(event.target);
      if (inputTarget) {
        if (action === 'ENTER') {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();

          if (view === 'token') {
            connectWithToken().catch((err: unknown) => {
              const message = err instanceof Error ? err.message : 'Token failed.';
              setErrorMessage(message);
            });
            return;
          }

          if (view === 'menu') {
            setMenuIndex(0);
            return;
          }
        }

        if (action === 'BACK') {
          event.preventDefault();
          (event.target as HTMLInputElement).blur();
        }
        return;
      }

      if (view === 'player') {
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

        if (showChannelList && action === 'UP') {
          event.preventDefault();
          setSelectedIndex((prev) => wrapIndex(prev - 1, categoryChannels.length));
          return;
        }

        if (showChannelList && action === 'DOWN') {
          event.preventDefault();
          setSelectedIndex((prev) => wrapIndex(prev + 1, categoryChannels.length));
          return;
        }

        if (showChannelList && action === 'LEFT') {
          event.preventDefault();
          setSelectedCategoryIndex((prev) => wrapIndex(prev - 1, categories.length));
          setSelectedIndex(0);
          return;
        }

        if (showChannelList && action === 'RIGHT') {
          event.preventDefault();
          setSelectedCategoryIndex((prev) => wrapIndex(prev + 1, categories.length));
          setSelectedIndex(0);
          return;
        }

        if (action === 'ENTER') {
          event.preventDefault();

          if (!showChannelList) {
            const currentPlayingChannel = channels.find(
              (channel) => channel.id === playingChannelId
            );
            if (currentPlayingChannel) {
              const currentCategoryName = getChannelGroupName(currentPlayingChannel);
              const categoryIndex = categories.findIndex(
                (category) => category.name === currentCategoryName
              );
              if (categoryIndex >= 0) {
                setSelectedCategoryIndex(categoryIndex);
                const channelIndex = categories[categoryIndex].channels.findIndex(
                  (channel) => channel.id === currentPlayingChannel.id
                );
                if (channelIndex >= 0) {
                  setSelectedIndex(channelIndex);
                }
              }
            }
            setShowChannelList(true);
            return;
          }

          if (videoRef.current && selectedChannel) {
            setAudioOnlyWarning(undefined);
            setPlayingChannelId(selectedChannel.id);
            setShowChannelList(false);
          }
          return;
        }

        if (action === 'MENU') {
          event.preventDefault();
          setShowChannelList((prev) => !prev);
          return;
        }

        if (action === 'BACK') {
          event.preventDefault();
          logoutDevice();
        }

        return;
      }

      if (view === 'menu') {
        if (action === 'UP') {
          event.preventDefault();
          setMenuIndex(0);
          return;
        }

        if (action === 'DOWN') {
          event.preventDefault();
          setMenuIndex(0);
          return;
        }

        if (action === 'ENTER') {
          event.preventDefault();
          startPairing().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : 'Pairing failed.';
            setErrorMessage(message);
            setView('menu');
          });
          return;
        }

        if (action === 'BACK') {
          event.preventDefault();
          window.close();
        }

        return;
      }

      if (view === 'settings') {
        if (action === 'UP') {
          event.preventDefault();
          setSettingsIndex((prev) => wrapIndex(prev - 1, SETTINGS_OPTIONS.length));
          return;
        }

        if (action === 'DOWN') {
          event.preventDefault();
          setSettingsIndex((prev) => wrapIndex(prev + 1, SETTINGS_OPTIONS.length));
          return;
        }

        if (action === 'LEFT') {
          event.preventDefault();
          changeSettingValue(-1);
          return;
        }

        if (action === 'RIGHT' || action === 'ENTER') {
          event.preventDefault();
          changeSettingValue(1);
          return;
        }

        if (action === 'BACK' || action === 'MENU') {
          event.preventDefault();
          setMenuIndex(0);
          setView('menu');
        }
        return;
      }

      if (view === 'token') {
        if (action === 'UP') {
          event.preventDefault();
          setTokenIndex((prev) => wrapIndex(prev - 1, TOKEN_ITEM_COUNT));
          return;
        }

        if (action === 'DOWN') {
          event.preventDefault();
          setTokenIndex((prev) => wrapIndex(prev + 1, TOKEN_ITEM_COUNT));
          return;
        }

        if (action === 'ENTER') {
          event.preventDefault();

          if (tokenIndex === 0) {
            tokenInputRef.current?.focus();
            return;
          }

          if (tokenIndex === 1) {
            connectWithToken().catch((err: unknown) => {
              const message = err instanceof Error ? err.message : 'Token failed.';
              setErrorMessage(message);
            });
            return;
          }

          setMenuIndex(0);
          setView('menu');
          return;
        }

        if (action === 'BACK') {
          event.preventDefault();
          setMenuIndex(0);
          setView('menu');
        }

        return;
      }

      if (view === 'pairing' && (action === 'ENTER' || action === 'BACK')) {
        event.preventDefault();
        clearPairPolling();
        setMenuIndex(0);
        setView('menu');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    categories,
    categoryChannels.length,
    channels,
    changeSettingValue,
    clearPairPolling,
    connectWithToken,
    logoutDevice,
    menuIndex,
    playingChannelId,
    saveApiBase,
    selectedChannel,
    showChannelList,
    stepChannelAndPlay,
    startPairing,
    tokenIndex,
    view
  ]);

  useEffect(() => {
    return () => {
      clearPairPolling();
    };
  }, [clearPairPolling]);

  const pairingQrImageUrl = pairingUrl
    ? `http://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(pairingUrl)}`
    : undefined;

  if (view === 'settings') {
    return (
      <div className="ott-settings">
        <div className="ott-settings__frame">
          <header className="ott-settings__header">
            <h1>Setari</h1>
            <button
              type="button"
              className="ott-settings__back"
              onClick={() => {
                setMenuIndex(0);
                setView('menu');
              }}
            >
              Back
            </button>
          </header>

          <div className="ott-settings__body">
            <section className="ott-settings__left">
              <div className="ott-settings__list">
                {visibleSettings.map((option, index) => {
                  const absoluteIndex = settingsVisibleWindow.start + index;
                  const valueIndex = settingsValues[option.id] ?? option.defaultIndex ?? 0;
                  const value = option.values[valueIndex] ?? option.values[0] ?? '-';
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={
                        absoluteIndex === settingsIndex
                          ? 'ott-settings__row ott-settings__row--active'
                          : 'ott-settings__row'
                      }
                      onClick={() => {
                        setSettingsIndex(absoluteIndex);
                      }}
                    >
                      <span className="ott-settings__label">{option.label}</span>
                      <span className="ott-settings__arrow">{'<'}</span>
                      <span className="ott-settings__value">{value}</span>
                      <span className="ott-settings__arrow">{'>'}</span>
                    </button>
                  );
                })}
              </div>
              <div className="ott-settings__scroll">
                <div
                  className="ott-settings__thumb"
                  style={{
                    height: `${settingsScroll.thumbHeight}%`,
                    top: `${settingsScroll.thumbTop}%`
                  }}
                />
              </div>
            </section>

            <aside className="ott-settings__right">
              <p className="ott-settings__datetime">{settingsClock}</p>
              <p className="ott-settings__help">
                {selectedSetting?.help ??
                  'Alege un rand din stanga si modifica valoarea cu LEFT/RIGHT.'}
              </p>
              <div className="ott-settings__palette" aria-hidden="true">
                <span className="ott-settings__swatch ott-settings__swatch--1" />
                <span className="ott-settings__swatch ott-settings__swatch--2" />
                <span className="ott-settings__swatch ott-settings__swatch--3" />
                <span className="ott-settings__swatch ott-settings__swatch--4" />
                <span className="ott-settings__swatch ott-settings__swatch--5" />
              </div>
            </aside>
          </div>

          <p className="ott-settings__hint">
            Remote: UP/DOWN rand, LEFT/RIGHT schimba, ENTER confirma, BACK intoarcere.
          </p>
        </div>
      </div>
    );
  }

  if (view !== 'player') {
    return (
      <div className="setup">
        <div className="setup__panel">
          {view === 'menu' ? (
            <>
              <header className="brand-header">
                <div>
                  <p className="brand-logo">AccountTV</p>
                  <h1>IPTV MAG Dashboard</h1>
                </div>
                <nav className="brand-nav">
                  <span>Home</span>
                  <span>Devices</span>
                  <span>Support</span>
                </nav>
              </header>

              <p className="setup__hint">
                Client flow simplificat: doar pairing cu cod. Datele playlist/EPG raman in dashboard-ul firmei.
              </p>
              <p className="remote-hint">Remote MAG250: UP/DOWN select, ENTER confirm, BACK return.</p>

              <div className="tile-grid">
                <button
                  type="button"
                  className={menuIndex === 0 ? 'tile-card tile-card--primary is-focused' : 'tile-card tile-card--primary'}
                  onClick={() => {
                    setMenuIndex(0);
                    startPairing().catch((err: unknown) => {
                      const message = err instanceof Error ? err.message : 'Pairing failed.';
                      setErrorMessage(message);
                      setView('menu');
                    });
                  }}
                >
                  <strong>Pair with code</strong>
                  <span>Porneste pairing-ul si confirma codul in dashboard-ul admin.</span>
                </button>
              </div>
            </>
          ) : null}

          {statusMessage ? <p className="msg msg--ok">{statusMessage}</p> : null}
          {errorMessage ? <p className="msg msg--error">{errorMessage}</p> : null}

          {view === 'pairing' ? (
            <div className="pairing">
              <h2>Pair this TV</h2>
              <p>Log in to web-admin and confirm this code.</p>
              <pre>{pairCode || '...'}</pre>
              {pairingQrImageUrl ? <img src={pairingQrImageUrl} alt="Pairing QR code" /> : null}
              {pairingUrl ? <p className="pairing__url">{pairingUrl}</p> : null}
              <div className="actions">
                <button
                  type="button"
                  className="action is-focused"
                  onClick={() => {
                    clearPairPolling();
                    setMenuIndex(0);
                    setView('menu');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {view === 'token' ? (
            <div className="token">
              <h2>Connect using device token</h2>
              <label className="field">
                <span>Device token</span>
                <input
                  ref={tokenInputRef}
                  className={tokenIndex === 0 ? 'is-focused' : undefined}
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder="paste token here"
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  className={
                    tokenIndex === 1 ? 'action action--primary is-focused' : 'action action--primary'
                  }
                  onClick={() => {
                    connectWithToken().catch((err: unknown) => {
                      const message = err instanceof Error ? err.message : 'Token failed.';
                      setErrorMessage(message);
                    });
                  }}
                >
                  Connect
                </button>
                <button
                  type="button"
                  className={tokenIndex === 2 ? 'action is-focused' : 'action'}
                  onClick={() => {
                    setMenuIndex(0);
                    setView('menu');
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={showChannelList ? 'player player--split' : 'player player--fullscreen'}>
      <main className={showChannelList ? 'screen screen--split' : 'screen screen--fullscreen'}>
        <video ref={videoRef} className="video" playsInline />
        <div className="screen__bar">
          <strong>{playingChannel?.name || 'No channel selected'}</strong>
          <span>
            {showChannelList ? 'ENTER play fullscreen' : 'UP/DOWN/CH+/- channel, OK or MENU list'}
          </span>
        </div>
        {audioOnlyWarning ? <p className="msg msg--error screen__error">{audioOnlyWarning}</p> : null}
        {errorMessage ? <p className="msg msg--error screen__error">{errorMessage}</p> : null}
      </main>

      {showChannelList ? (
        <aside className="channels channels--sheet">
          <h2>Categorii</h2>
          <p>LEFT/RIGHT categorie, UP/DOWN canal, ENTER play fullscreen.</p>
          <p>
            {selectedCategory?.name ?? '-'} ({selectedCategoryIndex + 1}/{categories.length})
          </p>
          <p>
            {categoryChannels.length ? selectedIndex + 1 : 0} / {categoryChannels.length}
          </p>
          <div className="channels__list">
            {visibleChannels.map((channel, index) => {
              const absoluteIndex = visibleWindow.start + index;
              return (
                <button
                  key={channel.id}
                  type="button"
                  className={absoluteIndex === selectedIndex ? 'channel channel--active' : 'channel'}
                  onClick={() => {
                    setSelectedIndex(absoluteIndex);
                    setPlayingChannelId(channel.id);
                    setShowChannelList(false);
                  }}
                >
                  {channel.name}
                </button>
              );
            })}
          </div>
        </aside>
      ) : null}
    </div>
  );
};

