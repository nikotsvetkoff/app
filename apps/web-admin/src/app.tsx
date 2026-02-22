import React, { useCallback, useEffect, useMemo, useState } from 'react';

const resolveApiBase = (): string => {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  if (typeof window === 'undefined') {
    return 'http://localhost:3000';
  }
  const host = window.location.hostname || 'localhost';
  return `http://${host}:3000`;
};

const API_BASE = resolveApiBase();
const TOKEN_KEY = 'iptv:web-admin:token';
const REMEMBER_ME_KEY = 'iptv:web-admin:remember-me';
const REGISTER_RESEND_COOLDOWN_SEC = 60;

type StatusTone = 'idle' | 'ok' | 'error';
type DevicePlaylistMode = 'GLOBAL' | 'SOURCE' | 'CUSTOM';
type FocusTopic =
  | 'account'
  | 'admins'
  | 'clients'
  | 'pairing'
  | 'history'
  | 'sources'
  | 'session'
  | 'api'
  | 'status';

interface ClientItem {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  devicesAllowed: number;
  pairedDevices: number;
  createdAt: string;
  updatedAt: string;
}

interface PairingHistoryItem {
  pairingId: string;
  code: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

interface PairedDeviceItem {
  id: string;
  name: string;
  platform: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  clientId: string | null;
  clientName: string | null;
  playlistMode: DevicePlaylistMode;
  customPlaylistId: string | null;
  customPlaylistName: string | null;
}

interface AdminItem {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

interface PlaylistStatusItem {
  sourceUrl: string | null;
  sourceLastError: string | null;
  cacheUpdatedAt: string | null;
  channelsCount: number;
  basePlaylistsCount: number;
  activeMode: 'source' | 'custom';
  activeCustomPlaylistId: string | null;
  activeCustomPlaylistName: string | null;
  activeChannelsCount: number;
}

interface BasePlaylistItem {
  id: string;
  name: string;
  url: string;
  channelsCount: number;
  cacheUpdatedAt: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlaylistChannelItem {
  id: string;
  name: string;
  logo?: string;
  group?: string;
  tvgId?: string;
  url: string;
  position: number;
  sourcePlaylistIds: string[];
  sourcePlaylistNames: string[];
}

interface CustomPlaylistListItem {
  id: string;
  name: string;
  channelsCount: number;
  isActive: boolean;
  sourcePlaylistIds: string[];
  sourcePlaylistNames: string[];
  createdAt: string;
  updatedAt: string;
}

interface CustomPlaylistDetailItem extends CustomPlaylistListItem {
  channels: PlaylistChannelItem[];
}

type LandingTile = 'playlists' | 'devices' | 'cabinet' | 'how';

const HELP_TEXT: Record<FocusTopic, string> = {
  account:
    'Введите email и пароль администратора. Регистрация отправляет код подтверждения на Gmail, вход доступен после ввода кода.',
  admins:
    'Здесь вы управляете администраторами приложения. Для добавления отправьте код на email и подтвердите его (8 цифр).',
  clients:
    'Клиент добавляется один раз, затем выбирается для каждой новой привязки устройств.',
  pairing:
    'Введите код с плеера, выберите клиента и режим плейлиста для устройства (global/source/custom).',
  history:
    'История показывает каждую подтвержденную привязку для выбранного клиента: код, устройство и дата.',
  sources:
    'Добавляйте несколько базовых плейлистов с названиями, собирайте custom из каналов и отслеживайте, из каких источников они собраны.',
  session: 'Активная сессия означает, что в браузере есть действительный токен администратора.',
  api: 'Это backend endpoint, который использует админ-панель.',
  status: 'Здесь отображается результат последнего запроса из панели.'
};

const fetchJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Таймаут подключения к API: ${url}`);
    }

    if (error instanceof TypeError) {
      throw new Error(`Не удалось подключиться к API: ${url}. Проверьте backend и сеть.`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const getPairCodeFromUrl = (): string => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('pairCode')?.toUpperCase() ?? '';
  } catch {
    return '';
  }
};

const getResetTokenFromUrl = (): string => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('resetToken')?.trim() ?? '';
  } catch {
    return '';
  }
};

const getStoredToken = (): string | null => {
  const localToken = localStorage.getItem(TOKEN_KEY);
  if (localToken) {
    return localToken;
  }

  const sessionToken = sessionStorage.getItem(TOKEN_KEY);
  if (sessionToken) {
    return sessionToken;
  }

  return null;
};

const getTokenStorageLabel = (): string => {
  if (localStorage.getItem(TOKEN_KEY)) {
    return 'Есть (долгий вход)';
  }

  if (sessionStorage.getItem(TOKEN_KEY)) {
    return 'Есть (до закрытия вкладки)';
  }

  return 'Отсутствует';
};

const clearStoredToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
};

const storeToken = (token: string, rememberMe: boolean): void => {
  clearStoredToken();
  if (rememberMe) {
    localStorage.setItem(TOKEN_KEY, token);
    return;
  }
  sessionStorage.setItem(TOKEN_KEY, token);
};

const getRememberMePreference = (): boolean => {
  const value = localStorage.getItem(REMEMBER_ME_KEY);
  if (value === '0') {
    return false;
  }
  return true;
};

const formatCountdown = (value: number): string => {
  const safe = Math.max(0, value);
  const min = Math.floor(safe / 60)
    .toString()
    .padStart(2, '0');
  const sec = (safe % 60).toString().padStart(2, '0');
  return `${min}:${sec}`;
};

const removeQueryParam = (key: string): void => {
  try {
    const currentUrl = new URL(window.location.href);
    if (!currentUrl.searchParams.has(key)) {
      return;
    }

    currentUrl.searchParams.delete(key);
    const query = currentUrl.searchParams.toString();
    const nextUrl = `${currentUrl.pathname}${query ? `?${query}` : ''}${currentUrl.hash}`;
    window.history.replaceState({}, '', nextUrl);
  } catch {
    // Ignore URL cleanup errors.
  }
};

const formatClock = (): string => {
  const now = new Date();
  const dateText = new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: '2-digit',
    month: 'long'
  }).format(now);
  const timeText = now.toLocaleTimeString('ru-RU', { hour12: false });
  return `${dateText}    ${timeText}`;
};

const formatDateTime = (value: string | null): string => {
  if (!value) {
    return '-';
  }
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const sortClients = (rows: ClientItem[]): ClientItem[] => {
  return [...rows].sort((a, b) => {
    const left = `${a.lastName} ${a.firstName}`.trim();
    const right = `${b.lastName} ${b.firstName}`.trim();
    return left.localeCompare(right, 'ru', { sensitivity: 'base' });
  });
};

const normalizeErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Request failed';
  }

  const raw = error.message.trim();
  if (!raw.startsWith('{')) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw) as { message?: string | string[] };
    if (Array.isArray(parsed.message)) {
      return parsed.message.join(', ');
    }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
    return raw;
  } catch {
    return raw;
  }
};

const pickSelectedClientId = (rows: ClientItem[], preferredId: string): string => {
  if (preferredId && rows.some((row) => row.id === preferredId)) {
    return preferredId;
  }
  return rows[0]?.id ?? '';
};

const sortPlaylistChannels = (rows: PlaylistChannelItem[]): PlaylistChannelItem[] => {
  return [...rows].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name, 'ru'));
};

const areStringArraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
};

const countHttpSchemes = (value: string): number => {
  const matches = value.match(/https?:\/\//gi);
  return matches ? matches.length : 0;
};

const normalizePath = (rawPath: string): string => {
  if (!rawPath || rawPath === '/') {
    return '/';
  }
  const noTrailing = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  return noTrailing || '/';
};

const decodeEmailFromToken = (token: string | null): string => {
  if (!token) {
    return '';
  }

  const payload = token.split('.')[1];
  if (!payload) {
    return '';
  }

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(normalized);
    const parsed = JSON.parse(json) as { email?: unknown };
    return typeof parsed.email === 'string' ? parsed.email : '';
  } catch {
    return '';
  }
};

export const App: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registerModalOpen, setRegisterModalOpen] = useState(false);
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerPasswordConfirm, setRegisterPasswordConfirm] = useState('');
  const [registerCode, setRegisterCode] = useState('');
  const [registerResendCooldownSec, setRegisterResendCooldownSec] = useState(0);
  const [rememberMe, setRememberMe] = useState(() => getRememberMePreference());
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState(() => getResetTokenFromUrl());
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [resetModalOpen, setResetModalOpen] = useState(() => Boolean(getResetTokenFromUrl()));
  const [forgotModalOpen, setForgotModalOpen] = useState(false);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [newAdminCode, setNewAdminCode] = useState('');
  const [newAdminResendCooldownSec, setNewAdminResendCooldownSec] = useState(0);

  const [clientFirstName, setClientFirstName] = useState('');
  const [clientLastName, setClientLastName] = useState('');
  const [clientPhone, setClientPhone] = useState('+373');
  const [clientAddress, setClientAddress] = useState('');
  const [clientDevicesAllowed, setClientDevicesAllowed] = useState('1');

  const [playlistSourceName, setPlaylistSourceName] = useState('');
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('https://epg.ott-play.com');
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistStatusItem | null>(null);
  const [basePlaylists, setBasePlaylists] = useState<BasePlaylistItem[]>([]);
  const [playlistChannels, setPlaylistChannels] = useState<PlaylistChannelItem[]>([]);
  const [customPlaylists, setCustomPlaylists] = useState<CustomPlaylistListItem[]>([]);
  const [selectedCustomPlaylistId, setSelectedCustomPlaylistId] = useState('');
  const [selectedCustomPlaylistName, setSelectedCustomPlaylistName] = useState('');
  const [newCustomPlaylistName, setNewCustomPlaylistName] = useState('');
  const [cloneCustomPlaylistName, setCloneCustomPlaylistName] = useState('');
  const [playlistSourceSearch, setPlaylistSourceSearch] = useState('');
  const [selectedSourceChannelIds, setSelectedSourceChannelIds] = useState<string[]>([]);
  const [customDraftChannelIds, setCustomDraftChannelIds] = useState<string[]>([]);
  const [customSavedChannelIds, setCustomSavedChannelIds] = useState<string[]>([]);

  const [clients, setClients] = useState<ClientItem[]>([]);
  const [admins, setAdmins] = useState<AdminItem[]>([]);
  const [pairedDevices, setPairedDevices] = useState<PairedDeviceItem[]>([]);
  const [devicePlaylistDrafts, setDevicePlaylistDrafts] = useState<
    Record<string, { mode: DevicePlaylistMode; customPlaylistId: string }>
  >({});
  const [selectedClientId, setSelectedClientId] = useState('');
  const [pairingHistory, setPairingHistory] = useState<PairingHistoryItem[]>([]);
  const [pairCode, setPairCode] = useState(() => getPairCodeFromUrl());
  const [pairPlaylistMode, setPairPlaylistMode] = useState<DevicePlaylistMode>('GLOBAL');
  const [pairCustomPlaylistId, setPairCustomPlaylistId] = useState('');
  const [editingClientId, setEditingClientId] = useState('');

  const [statusMessage, setStatusMessage] = useState('Готово.');
  const [statusTone, setStatusTone] = useState<StatusTone>('idle');
  const [focusTopic, setFocusTopic] = useState<FocusTopic>('status');
  const [clockLabel, setClockLabel] = useState(() => formatClock());
  const [tokenRevision, setTokenRevision] = useState(0);
  const [clientBusy, setClientBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [adminsBusy, setAdminsBusy] = useState(false);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [landingAuthOpen, setLandingAuthOpen] = useState(false);
  const [landingActiveTile, setLandingActiveTile] = useState<LandingTile>('how');
  const [landingMenuOpen, setLandingMenuOpen] = useState(false);
  const [landingPlaylistsPageOpen, setLandingPlaylistsPageOpen] = useState(false);
  const [landingSubscribersPageOpen, setLandingSubscribersPageOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);

  const token = useMemo(() => getStoredToken(), [tokenRevision]);
  const tokenStorageLabel = useMemo(() => getTokenStorageLabel(), [tokenRevision]);
  const tokenEmail = useMemo(() => decodeEmailFromToken(token), [token]);
  const welcomeEmail = tokenEmail || email.trim();
  const currentPath = useMemo(() => {
    try {
      return normalizePath(window.location.pathname);
    } catch {
      return '/';
    }
  }, []);
  const isKnownPath = currentPath === '/' || currentPath === '/index.html';

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  );

  const playlistChannelsById = useMemo(
    () => new Map(playlistChannels.map((channel) => [channel.id, channel] as const)),
    [playlistChannels]
  );

  const selectedCustomPlaylist = useMemo(
    () => customPlaylists.find((playlist) => playlist.id === selectedCustomPlaylistId) ?? null,
    [customPlaylists, selectedCustomPlaylistId]
  );

  const customDraftChannels = useMemo(() => {
    return customDraftChannelIds
      .map((channelId, index) => {
        const sourceChannel = playlistChannelsById.get(channelId);
        if (!sourceChannel) {
          return null;
        }

        return {
          ...sourceChannel,
          position: index + 1
        };
      })
      .filter((channel): channel is PlaylistChannelItem => Boolean(channel));
  }, [customDraftChannelIds, playlistChannelsById]);

  const filteredSourceChannels = useMemo(() => {
    const query = playlistSourceSearch.trim().toLowerCase();
    if (!query) {
      return playlistChannels;
    }

    return playlistChannels.filter((channel) => {
      const haystack = [
        channel.name,
        channel.group ?? '',
        channel.tvgId ?? '',
        channel.url,
        channel.sourcePlaylistNames.join(' ')
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [playlistChannels, playlistSourceSearch]);

  const hasCustomDraftChanges = useMemo(
    () => !areStringArraysEqual(customDraftChannelIds, customSavedChannelIds),
    [customDraftChannelIds, customSavedChannelIds]
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockLabel(formatClock());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (landingAuthOpen) {
      setLandingMenuOpen(false);
    }
  }, [landingAuthOpen]);

  useEffect(() => {
    if (!editingClientId) {
      return;
    }

    const stillExists = clients.some((client) => client.id === editingClientId);
    if (!stillExists) {
      setEditingClientId('');
      setClientFirstName('');
      setClientLastName('');
      setClientPhone('+373');
      setClientAddress('');
      setClientDevicesAllowed('1');
    }
  }, [clients, editingClientId]);

  useEffect(() => {
    if (selectedSourceChannelIds.length === 0) {
      return;
    }

    const availableIds = new Set(playlistChannels.map((channel) => channel.id));
    const nextSelection = selectedSourceChannelIds.filter((channelId) => availableIds.has(channelId));
    if (!areStringArraysEqual(nextSelection, selectedSourceChannelIds)) {
      setSelectedSourceChannelIds(nextSelection);
    }
  }, [playlistChannels, selectedSourceChannelIds]);

  useEffect(() => {
    if (pairPlaylistMode !== 'CUSTOM') {
      setPairCustomPlaylistId('');
      return;
    }

    if (!pairCustomPlaylistId) {
      return;
    }

    const exists = customPlaylists.some((playlist) => playlist.id === pairCustomPlaylistId);
    if (!exists) {
      setPairCustomPlaylistId('');
    }
  }, [customPlaylists, pairCustomPlaylistId, pairPlaylistMode]);

  useEffect(() => {
    setDevicePlaylistDrafts((current) => {
      const next: Record<string, { mode: DevicePlaylistMode; customPlaylistId: string }> = {};
      for (const device of pairedDevices) {
        const previous = current[device.id];
        const fallbackMode = device.playlistMode;
        const fallbackCustomPlaylistId = device.customPlaylistId ?? '';
        next[device.id] = previous
          ? {
              mode: previous.mode,
              customPlaylistId: previous.customPlaylistId
            }
          : {
              mode: fallbackMode,
              customPlaylistId: fallbackCustomPlaylistId
            };

        const draftCustomId = next[device.id].customPlaylistId;
        if (
          next[device.id].mode === 'CUSTOM' &&
          draftCustomId &&
          !customPlaylists.some((playlist) => playlist.id === draftCustomId)
        ) {
          next[device.id] = {
            mode: 'GLOBAL',
            customPlaylistId: ''
          };
        }
      }
      return next;
    });
  }, [customPlaylists, pairedDevices]);

  useEffect(() => {
    const closeMobileMenuOnDesktop = () => {
      if (window.innerWidth > 1100) {
        setLandingMenuOpen(false);
      }
    };

    closeMobileMenuOnDesktop();
    window.addEventListener('resize', closeMobileMenuOnDesktop);
    return () => {
      window.removeEventListener('resize', closeMobileMenuOnDesktop);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? '1' : '0');
  }, [rememberMe]);

  useEffect(() => {
    if (registerResendCooldownSec <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setRegisterResendCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [registerResendCooldownSec]);

  useEffect(() => {
    if (newAdminResendCooldownSec <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setNewAdminResendCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [newAdminResendCooldownSec]);

  useEffect(() => {
    const tokenFromResetUrl = getResetTokenFromUrl();
    if (!tokenFromResetUrl) {
      return;
    }

    setRegisterModalOpen(false);
    setResetToken(tokenFromResetUrl);
    setResetModalOpen(true);
    setForgotModalOpen(false);
    setLandingAuthOpen(false);
    setFocusTopic('account');
  }, []);

  const reportError = useCallback((error: unknown): void => {
    setStatusTone('error');
    setStatusMessage(normalizeErrorMessage(error));
    setFocusTopic('status');
  }, []);

  const requireToken = useCallback((overrideToken?: string): string => {
    const authToken = overrideToken ?? getStoredToken();
    if (!authToken) {
      throw new Error('Сначала выполните вход');
    }
    return authToken;
  }, []);

  const fetchClients = useCallback((authToken: string): Promise<ClientItem[]> => {
    return fetchJson<ClientItem[]>(`${API_BASE}/clients`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchAdmins = useCallback((authToken: string): Promise<AdminItem[]> => {
    return fetchJson<AdminItem[]>(`${API_BASE}/admins`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchDevices = useCallback((authToken: string): Promise<PairedDeviceItem[]> => {
    return fetchJson<PairedDeviceItem[]>(`${API_BASE}/devices`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchPlaylistStatus = useCallback((authToken: string): Promise<PlaylistStatusItem> => {
    return fetchJson<PlaylistStatusItem>(`${API_BASE}/playlist/status`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchSourceChannels = useCallback((authToken: string): Promise<PlaylistChannelItem[]> => {
    return fetchJson<PlaylistChannelItem[]>(`${API_BASE}/playlist/channels`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchBasePlaylists = useCallback((authToken: string): Promise<BasePlaylistItem[]> => {
    return fetchJson<BasePlaylistItem[]>(`${API_BASE}/playlist/sources`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchCustomPlaylists = useCallback((authToken: string): Promise<CustomPlaylistListItem[]> => {
    return fetchJson<CustomPlaylistListItem[]>(`${API_BASE}/playlist/custom`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
  }, []);

  const fetchCustomPlaylistDetail = useCallback(
    (authToken: string, playlistId: string): Promise<CustomPlaylistDetailItem> => {
      return fetchJson<CustomPlaylistDetailItem>(`${API_BASE}/playlist/custom/${playlistId}/channels`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
    },
    []
  );

  const fetchPairingHistory = useCallback(
    (authToken: string, clientId: string): Promise<PairingHistoryItem[]> => {
      return fetchJson<PairingHistoryItem[]>(`${API_BASE}/clients/${clientId}/pairings`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
    },
    []
  );

  const syncClients = useCallback(
    async (authToken: string, preferredSelectionId: string): Promise<ClientItem[]> => {
      const rows = sortClients(await fetchClients(authToken));
      setClients(rows);
      setSelectedClientId((current) => pickSelectedClientId(rows, preferredSelectionId || current));
      return rows;
    },
    [fetchClients]
  );

  const loadClients = useCallback(
    async (overrideToken?: string, preferredSelectionId = ''): Promise<void> => {
      setClientBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        await syncClients(authToken, preferredSelectionId);
      } catch (error) {
        reportError(error);
      } finally {
        setClientBusy(false);
      }
    },
    [reportError, requireToken, syncClients]
  );

  const loadAdmins = useCallback(
    async (overrideToken?: string): Promise<void> => {
      setAdminsBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        const rows = await fetchAdmins(authToken);
        setAdmins(rows);
      } catch (error) {
        reportError(error);
      } finally {
        setAdminsBusy(false);
      }
    },
    [fetchAdmins, reportError, requireToken]
  );

  const loadDevices = useCallback(
    async (overrideToken?: string): Promise<void> => {
      setDevicesBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        const rows = await fetchDevices(authToken);
        setPairedDevices(rows);
      } catch (error) {
        reportError(error);
      } finally {
        setDevicesBusy(false);
      }
    },
    [fetchDevices, reportError, requireToken]
  );

  const loadCustomPlaylistEditor = useCallback(
    async (authToken: string, playlistId: string): Promise<void> => {
      const detail = await fetchCustomPlaylistDetail(authToken, playlistId);
      const orderedIds = detail.channels.map((channel) => channel.id);
      setSelectedCustomPlaylistId(detail.id);
      setSelectedCustomPlaylistName(detail.name);
      setCustomDraftChannelIds(orderedIds);
      setCustomSavedChannelIds(orderedIds);
    },
    [fetchCustomPlaylistDetail]
  );

  const clearCustomPlaylistEditor = useCallback(() => {
    setSelectedCustomPlaylistId('');
    setSelectedCustomPlaylistName('');
    setCustomDraftChannelIds([]);
    setCustomSavedChannelIds([]);
    setSelectedSourceChannelIds([]);
  }, []);

  const loadPlaylistWorkspace = useCallback(
    async (overrideToken?: string, notify = false): Promise<void> => {
      setPlaylistBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        const [status, sourceChannels, customRows, baseRows] = await Promise.all([
          fetchPlaylistStatus(authToken),
          fetchSourceChannels(authToken).catch(() => []),
          fetchCustomPlaylists(authToken),
          fetchBasePlaylists(authToken)
        ]);

        setPlaylistStatus(status);
        setBasePlaylists(baseRows);
        setPlaylistChannels(sortPlaylistChannels(sourceChannels));
        setCustomPlaylists(customRows);

        const preferredCustomId =
          (selectedCustomPlaylistId && customRows.some((row) => row.id === selectedCustomPlaylistId)
            ? selectedCustomPlaylistId
            : '') ||
          (status.activeCustomPlaylistId && customRows.some((row) => row.id === status.activeCustomPlaylistId)
            ? status.activeCustomPlaylistId
            : '') ||
          customRows[0]?.id ||
          '';

        if (preferredCustomId) {
          await loadCustomPlaylistEditor(authToken, preferredCustomId);
        } else {
          clearCustomPlaylistEditor();
        }

        if (notify) {
          setStatusTone('ok');
          setStatusMessage('Плейлисты обновлены.');
          setFocusTopic('sources');
        }
      } catch (error) {
        reportError(error);
      } finally {
        setPlaylistBusy(false);
      }
    },
    [
      clearCustomPlaylistEditor,
      fetchBasePlaylists,
      fetchCustomPlaylists,
      fetchPlaylistStatus,
      fetchSourceChannels,
      loadCustomPlaylistEditor,
      reportError,
      requireToken,
      selectedCustomPlaylistId
    ]
  );

  const loadPairingHistory = useCallback(
    async (overrideToken?: string, clientId = selectedClientId): Promise<void> => {
      if (!clientId) {
        setPairingHistory([]);
        return;
      }

      setHistoryBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        const rows = await fetchPairingHistory(authToken, clientId);
        setPairingHistory(rows);
      } catch (error) {
        reportError(error);
      } finally {
        setHistoryBusy(false);
      }
    },
    [fetchPairingHistory, reportError, requireToken, selectedClientId]
  );

  useEffect(() => {
    if (!token) {
      setDashboardOpen(false);
      setLandingPlaylistsPageOpen(false);
      setLandingSubscribersPageOpen(false);
      setClients([]);
      setAdmins([]);
      setPairedDevices([]);
      setDevicePlaylistDrafts({});
      setPlaylistStatus(null);
      setBasePlaylists([]);
      setPlaylistChannels([]);
      setCustomPlaylists([]);
      setPlaylistSourceName('');
      setPlaylistUrl('');
      clearCustomPlaylistEditor();
      setNewCustomPlaylistName('');
      setCloneCustomPlaylistName('');
      setPlaylistSourceSearch('');
      setSelectedClientId('');
      setEditingClientId('');
      setPairingHistory([]);
      setPairPlaylistMode('GLOBAL');
      setPairCustomPlaylistId('');
      return;
    }
    void loadClients(token);
    void loadAdmins(token);
    void loadDevices(token);
    void loadPlaylistWorkspace(token);
  }, [clearCustomPlaylistEditor, loadAdmins, loadClients, loadDevices, loadPlaylistWorkspace, token]);

  useEffect(() => {
    if (!token || !selectedClientId) {
      setPairingHistory([]);
      return;
    }
    void loadPairingHistory(token, selectedClientId);
  }, [loadPairingHistory, selectedClientId, token]);

  useEffect(() => {
    if (!token || !landingPlaylistsPageOpen) {
      return;
    }

    void loadPlaylistWorkspace(token);
  }, [landingPlaylistsPageOpen, loadPlaylistWorkspace, token]);

  const callAuth = async (): Promise<void> => {
    try {
      const result = await fetchJson<{ accessToken: string; user?: { email?: string } }>(`${API_BASE}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      storeToken(result.accessToken, rememberMe);
      if (result.user?.email) {
        setEmail(result.user.email);
      }
      setTokenRevision((value) => value + 1);
      await syncClients(result.accessToken, selectedClientId);
      const adminsRows = await fetchAdmins(result.accessToken);
      setAdmins(adminsRows);

      setStatusTone('ok');
      setStatusMessage('Вход выполнен. Добро пожаловать!');
      setFocusTopic('session');
      setRegisterModalOpen(false);
      setForgotModalOpen(false);
      setLandingAuthOpen(false);
      setDashboardOpen(false);
    } catch (error) {
      reportError(error);
    }
  };

  const requestPasswordReset = async () => {
    try {
      const targetEmail = (resetEmail || email).trim().toLowerCase();
      if (!targetEmail) {
        throw new Error('Введите email для восстановления пароля.');
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/password/forgot`, {
        method: 'POST',
        body: JSON.stringify({ email: targetEmail })
      });

      setResetEmail(targetEmail);
      setStatusTone('ok');
      setStatusMessage(result.message);
      setFocusTopic('account');
      setForgotModalOpen(false);
      setLandingAuthOpen(true);
    } catch (error) {
      reportError(error);
    }
  };

  const startRegisterResendCooldown = () => {
    setRegisterResendCooldownSec(REGISTER_RESEND_COOLDOWN_SEC);
  };

  const openRegisterModal = () => {
    setRegisterEmail(email.trim().toLowerCase());
    setRegisterPassword('');
    setRegisterPasswordConfirm('');
    setRegisterCode('');
    setRegisterModalOpen(true);
    setLandingAuthOpen(false);
    setForgotModalOpen(false);
    setFocusTopic('account');
  };

  const closeRegisterModal = () => {
    setRegisterModalOpen(false);
    setRegisterCode('');
    setLandingAuthOpen(true);
  };

  const submitRegistrationForm = async () => {
    try {
      const normalizedEmail = registerEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new Error('Введите email для регистрации.');
      }

      if (registerPassword.length < 8) {
        throw new Error('Пароль должен содержать минимум 8 символов.');
      }

      if (registerPassword !== registerPasswordConfirm) {
        throw new Error('Пароль и подтверждение не совпадают.');
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register`, {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
          password: registerPassword
        })
      });

      setEmail(normalizedEmail);
      setRegisterPassword('');
      setRegisterPasswordConfirm('');
      startRegisterResendCooldown();
      setStatusTone('ok');
      setStatusMessage(result.message);
      setFocusTopic('account');
    } catch (error) {
      reportError(error);
    }
  };

  const confirmRegistrationForm = async () => {
    try {
      const normalizedCode = registerCode.trim();
      if (!/^\d{8}$/.test(normalizedCode)) {
        throw new Error('Введите 8-значный код из письма.');
      }

      const result = await fetchJson<{ accessToken: string; user?: { email?: string } }>(`${API_BASE}/auth/register/confirm`, {
        method: 'POST',
        body: JSON.stringify({ token: normalizedCode })
      });

      storeToken(result.accessToken, rememberMe);
      setTokenRevision((value) => value + 1);
      await syncClients(result.accessToken, selectedClientId);
      const adminsRows = await fetchAdmins(result.accessToken);
      setAdmins(adminsRows);

      if (result.user?.email) {
        setEmail(result.user.email);
      } else if (registerEmail.trim()) {
        setEmail(registerEmail.trim().toLowerCase());
      }

      setRegisterCode('');
      setRegisterPassword('');
      setRegisterPasswordConfirm('');
      setRegisterModalOpen(false);
      setLandingAuthOpen(false);
      setDashboardOpen(false);
      setStatusTone('ok');
      setStatusMessage('Код подтвержден. Регистрация завершена.');
      setFocusTopic('session');
    } catch (error) {
      reportError(error);
    }
  };

  const resendRegistrationForm = async () => {
    try {
      if (registerResendCooldownSec > 0) {
        throw new Error(`Повторная отправка будет доступна через ${formatCountdown(registerResendCooldownSec)}.`);
      }

      const normalizedEmail = registerEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new Error('Введите email для повторной отправки подтверждения.');
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register/resend`, {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail })
      });

      startRegisterResendCooldown();
      setStatusTone('ok');
      setStatusMessage(result.message);
      setFocusTopic('account');
    } catch (error) {
      reportError(error);
    }
  };

  const startNewAdminResendCooldown = () => {
    setNewAdminResendCooldownSec(REGISTER_RESEND_COOLDOWN_SEC);
  };

  const openForgotPasswordModal = () => {
    setResetEmail((current) => current || email.trim().toLowerCase());
    setRegisterModalOpen(false);
    setForgotModalOpen(true);
    setLandingAuthOpen(false);
    setFocusTopic('account');
  };

  const closeForgotPasswordModal = () => {
    setForgotModalOpen(false);
    setLandingAuthOpen(true);
  };

  const closeResetModal = () => {
    setResetModalOpen(false);
    setRegisterModalOpen(false);
    setForgotModalOpen(false);
    setResetToken('');
    setResetPassword('');
    setResetPasswordConfirm('');
    removeQueryParam('resetToken');
    setLandingAuthOpen(true);
  };

  const submitPasswordReset = async () => {
    try {
      const normalizedToken = resetToken.trim();
      if (!normalizedToken) {
        throw new Error('Токен восстановления отсутствует.');
      }

      if (resetPassword.length < 8) {
        throw new Error('Новый пароль должен содержать минимум 8 символов.');
      }

      if (resetPassword !== resetPasswordConfirm) {
        throw new Error('Пароли не совпадают.');
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/password/reset`, {
        method: 'POST',
        body: JSON.stringify({
          token: normalizedToken,
          password: resetPassword
        })
      });

      setStatusTone('ok');
      setStatusMessage(result.message);
      setFocusTopic('account');

      setResetModalOpen(false);
      setResetToken('');
      setResetPassword('');
      setResetPasswordConfirm('');
      removeQueryParam('resetToken');
      setLandingAuthOpen(true);
    } catch (error) {
      reportError(error);
    }
  };

  const logout = () => {
    clearStoredToken();
    setTokenRevision((value) => value + 1);
    setDashboardOpen(false);
    setLandingPlaylistsPageOpen(false);
    setLandingSubscribersPageOpen(false);
    setLandingAuthOpen(false);
    setRegisterModalOpen(false);
    setForgotModalOpen(false);
    setClients([]);
    setAdmins([]);
    setSelectedClientId('');
    setEditingClientId('');
    setStatusTone('ok');
    setStatusMessage('Локальный токен удален.');
    setFocusTopic('session');
  };

  const requestNewAdminCode = async () => {
    try {
      const normalizedEmail = newAdminEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new Error('Введите email нового администратора.');
      }

      if (newAdminPassword.trim().length < 8) {
        throw new Error('Пароль нового администратора должен содержать минимум 8 символов.');
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register`, {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
          password: newAdminPassword.trim()
        })
      });

      setNewAdminEmail(normalizedEmail);
      startNewAdminResendCooldown();
      setStatusTone('ok');
      setStatusMessage(result.message);
      setFocusTopic('admins');
    } catch (error) {
      reportError(error);
    }
  };

  const resendNewAdminCode = async () => {
    try {
      if (newAdminResendCooldownSec > 0) {
        throw new Error(`Повторная отправка будет доступна через ${formatCountdown(newAdminResendCooldownSec)}.`);
      }

      const normalizedEmail = newAdminEmail.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new Error('Введите email нового администратора.');
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register/resend`, {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail })
      });

      startNewAdminResendCooldown();
      setStatusTone('ok');
      setStatusMessage(result.message);
      setFocusTopic('admins');
    } catch (error) {
      reportError(error);
    }
  };

  const confirmNewAdminCode = async () => {
    try {
      const authToken = requireToken();
      const normalizedCode = newAdminCode.trim();
      if (!/^\d{8}$/.test(normalizedCode)) {
        throw new Error('Введите 8-значный код нового администратора.');
      }

      await fetchJson<{ accessToken: string }>(`${API_BASE}/auth/register/confirm`, {
        method: 'POST',
        body: JSON.stringify({ token: normalizedCode })
      });

      await loadAdmins(authToken);
      setNewAdminEmail('');
      setNewAdminPassword('');
      setNewAdminCode('');
      setNewAdminResendCooldownSec(0);
      setStatusTone('ok');
      setStatusMessage('Новый администратор подтвержден и добавлен.');
      setFocusTopic('admins');
    } catch (error) {
      reportError(error);
    }
  };

  const deleteAdmin = async (admin: AdminItem) => {
    const accepted = window.confirm(`Удалить администратора ${admin.email}?`);
    if (!accepted) {
      return;
    }

    try {
      const authToken = requireToken();
      await fetchJson<{ success: true }>(`${API_BASE}/admins/${admin.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      await loadAdmins(authToken);
      setStatusTone('ok');
      setStatusMessage(`Администратор удален: ${admin.email}.`);
      setFocusTopic('admins');
    } catch (error) {
      reportError(error);
    }
  };

  const createClient = async () => {
    try {
      const devicesAllowed = Number.parseInt(clientDevicesAllowed, 10);
      if (!Number.isFinite(devicesAllowed) || devicesAllowed < 1) {
        throw new Error('Количество устройств должно быть не меньше 1.');
      }

      const authToken = requireToken();
      const created = await fetchJson<ClientItem>(`${API_BASE}/clients`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          firstName: clientFirstName,
          lastName: clientLastName,
          phone: clientPhone,
          address: clientAddress,
          devicesAllowed
        })
      });

      await syncClients(authToken, created.id);
      setSelectedClientId(created.id);
      setEditingClientId('');
      setClientFirstName('');
      setClientLastName('');
      setClientPhone('+373');
      setClientAddress('');
      setClientDevicesAllowed('1');

      setStatusTone('ok');
      setStatusMessage(`Клиент добавлен: ${created.lastName} ${created.firstName}.`);
      setFocusTopic('clients');
    } catch (error) {
      reportError(error);
    }
  };

  const startEditClient = (client: ClientItem): void => {
    setEditingClientId(client.id);
    setSelectedClientId(client.id);
    setClientFirstName(client.firstName);
    setClientLastName(client.lastName);
    setClientPhone(client.phone);
    setClientAddress(client.address);
    setClientDevicesAllowed(String(client.devicesAllowed));
    setFocusTopic('clients');
  };

  const cancelEditClient = (): void => {
    setEditingClientId('');
    setClientFirstName('');
    setClientLastName('');
    setClientPhone('+373');
    setClientAddress('');
    setClientDevicesAllowed('1');
  };

  const saveEditedClient = async (): Promise<void> => {
    try {
      if (!editingClientId) {
        throw new Error('Сначала выберите абонента из списка.');
      }

      const devicesAllowed = Number.parseInt(clientDevicesAllowed, 10);
      if (!Number.isFinite(devicesAllowed) || devicesAllowed < 1) {
        throw new Error('Количество устройств должно быть не меньше 1.');
      }

      const authToken = requireToken();
      const updated = await fetchJson<ClientItem>(`${API_BASE}/clients/${editingClientId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          firstName: clientFirstName,
          lastName: clientLastName,
          phone: clientPhone,
          address: clientAddress,
          devicesAllowed
        })
      });

      await syncClients(authToken, updated.id);
      cancelEditClient();
      setStatusTone('ok');
      setStatusMessage(`Абонент обновлен: ${updated.lastName} ${updated.firstName}.`);
      setFocusTopic('clients');
    } catch (error) {
      reportError(error);
    }
  };

  const updateClientLimit = async (client: ClientItem, nextLimit: number) => {
    try {
      const authToken = requireToken();
      await fetchJson<ClientItem>(`${API_BASE}/clients/${client.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ devicesAllowed: nextLimit })
      });

      await syncClients(authToken, client.id);
      setStatusTone('ok');
      setStatusMessage(`Лимит обновлен для ${client.lastName} ${client.firstName}: ${nextLimit} устройств.`);
      setFocusTopic('clients');
    } catch (error) {
      reportError(error);
    }
  };

  const deleteClient = async (client: ClientItem) => {
    const accepted = window.confirm(`Удалить клиента ${client.lastName} ${client.firstName}?`);
    if (!accepted) {
      return;
    }

    try {
      const authToken = requireToken();
      await fetchJson<{ success: true }>(`${API_BASE}/clients/${client.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      const preferredSelection = selectedClientId === client.id ? '' : selectedClientId;
      await syncClients(authToken, preferredSelection);
      if (editingClientId === client.id) {
        cancelEditClient();
      }
      setStatusTone('ok');
      setStatusMessage(`Клиент удален: ${client.lastName} ${client.firstName}.`);
      setFocusTopic('clients');
    } catch (error) {
      reportError(error);
    }
  };

  const confirmPair = async () => {
    try {
      const normalizedCode = pairCode.trim().toUpperCase();
      if (!normalizedCode) {
        throw new Error('Введите код привязки.');
      }
      if (!selectedClientId) {
        throw new Error('Выберите клиента перед привязкой.');
      }
      if (pairPlaylistMode === 'CUSTOM' && !pairCustomPlaylistId) {
        throw new Error('Выберите custom-плейлист для устройства.');
      }

      const authToken = requireToken();
      await fetchJson<{ success: true }>(`${API_BASE}/devices/pair/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          code: normalizedCode,
          clientId: selectedClientId,
          playlistMode: pairPlaylistMode,
          customPlaylistId: pairPlaylistMode === 'CUSTOM' ? pairCustomPlaylistId : undefined
        })
      });

      await syncClients(authToken, selectedClientId);
      await loadPairingHistory(authToken, selectedClientId);
      await loadDevices(authToken);
      setPairCode('');
      setPairPlaylistMode('GLOBAL');
      setPairCustomPlaylistId('');
      setStatusTone('ok');
      setStatusMessage('Привязка подтверждена для выбранного клиента.');
      setFocusTopic('pairing');
    } catch (error) {
      reportError(error);
    }
  };

  const getDevicePlaylistDraft = (
    device: PairedDeviceItem
  ): { mode: DevicePlaylistMode; customPlaylistId: string } => {
    return (
      devicePlaylistDrafts[device.id] ?? {
        mode: device.playlistMode,
        customPlaylistId: device.customPlaylistId ?? ''
      }
    );
  };

  const setDevicePlaylistModeDraft = (deviceId: string, mode: DevicePlaylistMode): void => {
    setDevicePlaylistDrafts((current) => ({
      ...current,
      [deviceId]: {
        mode,
        customPlaylistId: mode === 'CUSTOM' ? (current[deviceId]?.customPlaylistId ?? '') : ''
      }
    }));
  };

  const setDeviceCustomPlaylistDraft = (deviceId: string, customPlaylistId: string): void => {
    setDevicePlaylistDrafts((current) => ({
      ...current,
      [deviceId]: {
        mode: current[deviceId]?.mode ?? 'CUSTOM',
        customPlaylistId
      }
    }));
  };

  const saveDevicePlaylistAssignment = async (device: PairedDeviceItem): Promise<void> => {
    const draft = getDevicePlaylistDraft(device);
    if (draft.mode === 'CUSTOM' && !draft.customPlaylistId) {
      setStatusTone('error');
      setStatusMessage('Для режима CUSTOM выберите плейлист.');
      setFocusTopic('pairing');
      return;
    }

    try {
      const authToken = requireToken();
      setDevicesBusy(true);
      await fetchJson<PairedDeviceItem>(`${API_BASE}/devices/${device.id}/playlist`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          playlistMode: draft.mode,
          customPlaylistId: draft.mode === 'CUSTOM' ? draft.customPlaylistId : undefined
        })
      });

      await loadDevices(authToken);
      setStatusTone('ok');
      setStatusMessage(`Плейлист устройства обновлен: ${device.name}.`);
      setFocusTopic('pairing');
    } catch (error) {
      reportError(error);
    } finally {
      setDevicesBusy(false);
    }
  };

  const savePlaylist = async () => {
    try {
      const normalizedName = playlistSourceName.trim();
      const normalizedUrl = playlistUrl.trim();
      if (!normalizedName) {
        throw new Error('Введите название базового плейлиста.');
      }
      if (!normalizedUrl) {
        throw new Error('Введите URL плейлиста.');
      }
      if (countHttpSchemes(normalizedUrl) > 1) {
        throw new Error('URL содержит больше одной ссылки. Вставьте только один полный URL.');
      }

      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<BasePlaylistItem>(`${API_BASE}/playlist/sources`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: normalizedName, url: normalizedUrl })
      });

      await loadPlaylistWorkspace(authToken);
      setPlaylistSourceName('');
      setPlaylistUrl('');

      setStatusTone('ok');
      setStatusMessage(`Базовый плейлист добавлен: ${normalizedName}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const refreshBasePlaylist = async (playlistId: string, playlistName: string): Promise<void> => {
    try {
      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<BasePlaylistItem>(`${API_BASE}/playlist/sources/${playlistId}/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      await loadPlaylistWorkspace(authToken);
      setStatusTone('ok');
      setStatusMessage(`Источник обновлен: ${playlistName}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const renameBasePlaylist = async (playlist: BasePlaylistItem): Promise<void> => {
    const nextName = window.prompt('Новое название плейлиста:', playlist.name)?.trim() ?? '';
    if (!nextName || nextName === playlist.name) {
      return;
    }

    try {
      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<BasePlaylistItem>(`${API_BASE}/playlist/sources/${playlist.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: nextName })
      });
      await loadPlaylistWorkspace(authToken);
      setStatusTone('ok');
      setStatusMessage(`Источник переименован: ${nextName}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const updateBasePlaylistUrl = async (playlist: BasePlaylistItem): Promise<void> => {
    const nextUrl = window.prompt('Новый URL плейлиста:', playlist.url)?.trim() ?? '';
    if (!nextUrl || nextUrl === playlist.url) {
      return;
    }
    if (countHttpSchemes(nextUrl) > 1) {
      setStatusTone('error');
      setStatusMessage('URL содержит больше одной ссылки. Вставьте только один полный URL.');
      setFocusTopic('sources');
      return;
    }

    try {
      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<BasePlaylistItem>(`${API_BASE}/playlist/sources/${playlist.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ url: nextUrl })
      });
      await loadPlaylistWorkspace(authToken);
      setStatusTone('ok');
      setStatusMessage(`URL обновлен для источника: ${playlist.name}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const deleteBasePlaylist = async (playlist: BasePlaylistItem): Promise<void> => {
    const accepted = window.confirm(`Удалить базовый плейлист "${playlist.name}"?`);
    if (!accepted) {
      return;
    }

    try {
      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<{ success: true }>(`${API_BASE}/playlist/sources/${playlist.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });
      await loadPlaylistWorkspace(authToken);
      setStatusTone('ok');
      setStatusMessage(`Источник удален: ${playlist.name}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const toggleSourceChannelSelection = (channelId: string): void => {
    setSelectedSourceChannelIds((current) =>
      current.includes(channelId)
        ? current.filter((existingId) => existingId !== channelId)
        : [...current, channelId]
    );
  };

  const clearSourceChannelSelection = (): void => {
    setSelectedSourceChannelIds([]);
  };

  const selectAllFilteredSourceChannels = (): void => {
    setSelectedSourceChannelIds(filteredSourceChannels.map((channel) => channel.id));
  };

  const addSelectedChannelsToCustomDraft = (): void => {
    if (!selectedCustomPlaylistId) {
      setStatusTone('error');
      setStatusMessage('Сначала выберите пользовательский плейлист.');
      setFocusTopic('sources');
      return;
    }

    if (selectedSourceChannelIds.length === 0) {
      setStatusTone('error');
      setStatusMessage('Выберите каналы из списка источника.');
      setFocusTopic('sources');
      return;
    }

    setCustomDraftChannelIds((current) => {
      const next = [...current];
      const existing = new Set(current);
      for (const channelId of selectedSourceChannelIds) {
        if (!existing.has(channelId)) {
          existing.add(channelId);
          next.push(channelId);
        }
      }
      return next;
    });
    setSelectedSourceChannelIds([]);
    setStatusTone('ok');
    setStatusMessage('Каналы добавлены в пользовательский плейлист (черновик).');
    setFocusTopic('sources');
  };

  const removeDraftChannel = (channelId: string): void => {
    setCustomDraftChannelIds((current) => current.filter((existingId) => existingId !== channelId));
  };

  const moveDraftChannel = (index: number, direction: -1 | 1): void => {
    setCustomDraftChannelIds((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next;
    });
  };

  const loadCustomPlaylistById = async (playlistId: string): Promise<void> => {
    try {
      const authToken = requireToken();
      setPlaylistBusy(true);
      await loadCustomPlaylistEditor(authToken, playlistId);
      setStatusTone('ok');
      setStatusMessage('Пользовательский плейлист открыт для редактирования.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const createCustomPlaylist = async (): Promise<void> => {
    try {
      const name = newCustomPlaylistName.trim();
      if (!name) {
        throw new Error('Введите название нового пользовательского плейлиста.');
      }

      const authToken = requireToken();
      setPlaylistBusy(true);
      const created = await fetchJson<CustomPlaylistListItem>(`${API_BASE}/playlist/custom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name })
      });

      const rows = await fetchCustomPlaylists(authToken);
      setCustomPlaylists(rows);
      await loadCustomPlaylistEditor(authToken, created.id);
      setNewCustomPlaylistName('');
      setCloneCustomPlaylistName('');
      setStatusTone('ok');
      setStatusMessage(`Создан пользовательский плейлист: ${created.name}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const renameSelectedCustomPlaylist = async (): Promise<void> => {
    try {
      if (!selectedCustomPlaylistId) {
        throw new Error('Сначала выберите пользовательский плейлист.');
      }

      const nextName = selectedCustomPlaylistName.trim();
      if (!nextName) {
        throw new Error('Введите название плейлиста.');
      }

      const authToken = requireToken();
      setPlaylistBusy(true);
      const updated = await fetchJson<CustomPlaylistListItem>(
        `${API_BASE}/playlist/custom/${selectedCustomPlaylistId}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ name: nextName })
        }
      );

      const rows = await fetchCustomPlaylists(authToken);
      setCustomPlaylists(rows);
      setSelectedCustomPlaylistName(updated.name);
      setStatusTone('ok');
      setStatusMessage(`Плейлист переименован: ${updated.name}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const saveCustomPlaylistDraft = async (): Promise<void> => {
    try {
      if (!selectedCustomPlaylistId) {
        throw new Error('Сначала выберите пользовательский плейлист.');
      }

      const authToken = requireToken();
      setPlaylistBusy(true);

      const detail = await fetchJson<CustomPlaylistDetailItem>(
        `${API_BASE}/playlist/custom/${selectedCustomPlaylistId}/channels`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ channelIds: customDraftChannelIds })
        }
      );

      const orderedIds = detail.channels.map((channel) => channel.id);
      setCustomDraftChannelIds(orderedIds);
      setCustomSavedChannelIds(orderedIds);
      setSelectedCustomPlaylistName(detail.name);

      const [rows, status] = await Promise.all([
        fetchCustomPlaylists(authToken),
        fetchPlaylistStatus(authToken)
      ]);
      setCustomPlaylists(rows);
      setPlaylistStatus(status);

      setStatusTone('ok');
      setStatusMessage('Изменения пользовательского плейлиста сохранены.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const cloneCurrentCustomPlaylist = async (): Promise<void> => {
    try {
      if (!selectedCustomPlaylistId) {
        throw new Error('Сначала выберите пользовательский плейлист.');
      }

      const cloneName =
        cloneCustomPlaylistName.trim() || `${selectedCustomPlaylistName.trim() || 'Плейлист'} (копия)`;
      const authToken = requireToken();
      setPlaylistBusy(true);

      const created = await fetchJson<CustomPlaylistListItem>(`${API_BASE}/playlist/custom`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: cloneName })
      });

      await fetchJson<CustomPlaylistDetailItem>(`${API_BASE}/playlist/custom/${created.id}/channels`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ channelIds: customDraftChannelIds })
      });

      const [rows, status] = await Promise.all([
        fetchCustomPlaylists(authToken),
        fetchPlaylistStatus(authToken)
      ]);
      setCustomPlaylists(rows);
      setPlaylistStatus(status);
      await loadCustomPlaylistEditor(authToken, created.id);
      setCloneCustomPlaylistName('');
      setStatusTone('ok');
      setStatusMessage(`Создан новый плейлист из выбранных каналов: ${cloneName}.`);
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const deleteSelectedCustomPlaylist = async (): Promise<void> => {
    try {
      if (!selectedCustomPlaylistId || !selectedCustomPlaylist) {
        throw new Error('Сначала выберите пользовательский плейлист.');
      }

      const accepted = window.confirm(`Удалить плейлист "${selectedCustomPlaylist.name}"?`);
      if (!accepted) {
        return;
      }

      const deletedId = selectedCustomPlaylist.id;
      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<{ success: true }>(`${API_BASE}/playlist/custom/${deletedId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      const [rows, status] = await Promise.all([
        fetchCustomPlaylists(authToken),
        fetchPlaylistStatus(authToken)
      ]);
      setCustomPlaylists(rows);
      setPlaylistStatus(status);

      const nextPlaylistId = rows.find((row) => row.id !== deletedId)?.id ?? '';
      if (nextPlaylistId) {
        await loadCustomPlaylistEditor(authToken, nextPlaylistId);
      } else {
        clearCustomPlaylistEditor();
      }

      setStatusTone('ok');
      setStatusMessage('Пользовательский плейлист удален.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const activateSelectedCustomPlaylist = async (): Promise<void> => {
    try {
      if (!selectedCustomPlaylistId) {
        throw new Error('Сначала выберите пользовательский плейлист.');
      }

      const authToken = requireToken();
      setPlaylistBusy(true);

      if (hasCustomDraftChanges) {
        await fetchJson<CustomPlaylistDetailItem>(
          `${API_BASE}/playlist/custom/${selectedCustomPlaylistId}/channels`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ channelIds: customDraftChannelIds })
          }
        );
        setCustomSavedChannelIds(customDraftChannelIds);
      }

      await fetchJson<{ success: true }>(`${API_BASE}/playlist/custom/${selectedCustomPlaylistId}/activate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      const [rows, status] = await Promise.all([
        fetchCustomPlaylists(authToken),
        fetchPlaylistStatus(authToken)
      ]);
      setCustomPlaylists(rows);
      setPlaylistStatus(status);
      setStatusTone('ok');
      setStatusMessage('Активирован пользовательский плейлист для приложений.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const activateSourcePlaylist = async (): Promise<void> => {
    try {
      const authToken = requireToken();
      setPlaylistBusy(true);
      await fetchJson<{ success: true }>(`${API_BASE}/playlist/activate-source`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` }
      });

      const [rows, status] = await Promise.all([
        fetchCustomPlaylists(authToken),
        fetchPlaylistStatus(authToken)
      ]);
      setCustomPlaylists(rows);
      setPlaylistStatus(status);
      setStatusTone('ok');
      setStatusMessage('Активирован исходный плейлист.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const saveEpg = async () => {
    try {
      const authToken = requireToken();
      await fetchJson<{ success: true }>(`${API_BASE}/epg/set-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ url: epgUrl })
      });

      setStatusTone('ok');
      setStatusMessage('EPG использует фиксированный источник: https://epg.ott-play.com.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    }
  };

  const openLandingAuth = () => {
    if (token) {
      setDashboardOpen(true);
      setLandingAuthOpen(false);
      setRegisterModalOpen(false);
      setForgotModalOpen(false);
      setFocusTopic('session');
      return;
    }

    setLandingAuthOpen(true);
    setRegisterModalOpen(false);
    setForgotModalOpen(false);
    setFocusTopic('account');
  };

  const openLandingTile = (tile: Exclude<LandingTile, 'cabinet'>): void => {
    setLandingActiveTile(tile);
    setLandingPlaylistsPageOpen(false);
    setLandingSubscribersPageOpen(false);
    setEditingClientId('');

    if (tile === 'devices' && token) {
      void loadDevices(token);
      void loadClients(token, selectedClientId);
      setFocusTopic('pairing');
    }
  };

  const openLandingHome = (): void => {
    openLandingTile('playlists');
    setLandingMenuOpen(false);
  };

  const openPlaylistsPage = (): void => {
    setLandingActiveTile('playlists');
    setLandingPlaylistsPageOpen(true);
    setLandingSubscribersPageOpen(false);
    setLandingMenuOpen(false);
    setFocusTopic('sources');

    if (token) {
      void loadPlaylistWorkspace(token);
    }
  };

  const openSubscribersPage = (): void => {
    setLandingActiveTile('cabinet');
    setLandingPlaylistsPageOpen(false);
    setLandingSubscribersPageOpen(true);
    setLandingMenuOpen(false);
    setFocusTopic('clients');

    if (token) {
      void loadClients(token, selectedClientId);
    }
  };

  if (!isKnownPath) {
    return (
      <div className="wa-ott wa-ott--notfound">
        <section className="wa-notfound-shell">
          <div className="wa-notfound-brand">
            <img src="/accounttv-icon.png" alt="Логотип AccountTV" className="wa-notfound-logo" />
            <div>
              <p className="wa-notfound-brand-title">AccountTV</p>
              <p className="wa-notfound-brand-subtitle">admin panel</p>
            </div>
          </div>

          <p className="wa-notfound-code">404</p>
          <h1 className="wa-notfound-title">Страница не найдена</h1>
          <p className="wa-notfound-text">
            Запрошенный адрес отсутствует. Проверьте ссылку или вернитесь на главную страницу приложения.
          </p>
          <p className="wa-notfound-path">Путь: {currentPath}</p>

          <div className="wa-notfound-actions">
            <button
              type="button"
              className="wa-base-auth-btn wa-base-auth-btn--primary"
              onClick={() => window.location.assign('/')}
            >
              На главную
            </button>
            <button
              type="button"
              className="wa-base-auth-btn"
              onClick={() => window.location.assign('/')}
            >
              {token ? 'В панель' : 'К входу'}
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (!token || !dashboardOpen) {
    return (
      <div className="wa-ott wa-ott--base">
        <div className="wa-base-shell">
          <header className="wa-base-topbar">
            <nav className="wa-base-top-nav" aria-label="Основное меню">
              <button
                type="button"
                className={landingActiveTile === 'playlists' ? 'wa-base-top-nav-item is-active' : 'wa-base-top-nav-item'}
                onClick={openLandingHome}
              >
                Главная
              </button>
              <button
                type="button"
                className={landingPlaylistsPageOpen ? 'wa-base-top-nav-item is-active' : 'wa-base-top-nav-item'}
                onClick={openPlaylistsPage}
              >
                Плейлисты
              </button>
              <button
                type="button"
                className={landingActiveTile === 'devices' ? 'wa-base-top-nav-item is-active' : 'wa-base-top-nav-item'}
                onClick={() => openLandingTile('devices')}
              >
                Устройства
              </button>
              <button
                type="button"
                className={landingActiveTile === 'cabinet' ? 'wa-base-top-nav-item is-active' : 'wa-base-top-nav-item'}
                onClick={openSubscribersPage}
              >
                Абоненты
              </button>
              <button
                type="button"
                className={landingActiveTile === 'how' ? 'wa-base-top-nav-item is-active' : 'wa-base-top-nav-item'}
                onClick={() => openLandingTile('how')}
              >
                Как это работает
              </button>
            </nav>

            {token ? (
              <div className="wa-base-top-session">
                <div className="wa-base-top-account">
                  <p className="wa-base-top-account-title">Добро пожаловать</p>
                  <p className="wa-base-top-account-email">{welcomeEmail || 'администратор'}</p>
                </div>
                <button type="button" className="wa-base-top-login" onClick={() => setDashboardOpen(true)}>
                  Админ-панель
                </button>
              </div>
            ) : (
              <button type="button" className="wa-base-top-login" onClick={openLandingAuth}>
                Вход администратора
              </button>
            )}
          </header>

          <button
            type="button"
            className={landingMenuOpen ? 'wa-base-burger is-open' : 'wa-base-burger'}
            onClick={() => setLandingMenuOpen((prev) => !prev)}
            aria-label={landingMenuOpen ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={landingMenuOpen}
          >
            <span />
            <span />
            <span />
          </button>

          <aside className={landingMenuOpen ? 'wa-base-side-menu is-open' : 'wa-base-side-menu'} aria-label="Боковое меню">
            <p className="wa-base-side-menu-title">Меню</p>
            {token ? (
              <div className="wa-base-side-session">
                <p className="wa-base-side-session-title">Добро пожаловать</p>
                <p className="wa-base-side-session-email">{welcomeEmail || 'администратор'}</p>
              </div>
            ) : null}
            <button
              type="button"
              className="wa-base-side-menu-item"
              onClick={() => {
                openLandingHome();
              }}
            >
              Главная
            </button>
            <button
              type="button"
              className="wa-base-side-menu-item"
              onClick={() => {
                openPlaylistsPage();
              }}
            >
              Плейлисты
            </button>
            <button
              type="button"
              className="wa-base-side-menu-item"
              onClick={() => {
                openLandingTile('devices');
                setLandingMenuOpen(false);
              }}
            >
              Устройства
            </button>
            <button
              type="button"
              className="wa-base-side-menu-item"
              onClick={() => {
                openSubscribersPage();
              }}
            >
              Абоненты
            </button>
            <button
              type="button"
              className="wa-base-side-menu-item"
              onClick={() => {
                openLandingTile('how');
                setLandingMenuOpen(false);
              }}
            >
              Как это работает
            </button>
            <button
              type="button"
              className="wa-base-side-menu-item wa-base-side-menu-item--accent"
              onClick={() => {
                if (token) {
                  setDashboardOpen(true);
                } else {
                  openLandingAuth();
                }
                setLandingMenuOpen(false);
              }}
            >
              {token ? 'Админ-панель' : 'Вход администратора'}
            </button>
            {token ? (
              <button
                type="button"
                className="wa-base-side-menu-item"
                onClick={() => {
                  logout();
                  setLandingMenuOpen(false);
                }}
              >
                Выйти
              </button>
            ) : null}
          </aside>

          {landingMenuOpen ? <button type="button" className="wa-base-side-menu-backdrop" onClick={() => setLandingMenuOpen(false)} aria-label="Закрыть меню" /> : null}

          {landingPlaylistsPageOpen ? (
            <section className="wa-base-playlists" aria-label="Плейлисты">
              <div className="wa-base-playlists-head">
                <h2 className="wa-base-playlists-title">Плейлисты</h2>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--ghost"
                  onClick={openLandingHome}
                >
                  На главную
                </button>
              </div>

              <p className="wa-base-playlists-text">
                Здесь вы добавляете несколько базовых M3U-плейлистов, даете им названия и собираете из них custom-плейлисты.
              </p>

              {token ? (
                <>
                  <label className="wa-row">
                    <span className="wa-label">Название базового плейлиста</span>
                    <input
                      className="wa-input"
                      value={playlistSourceName}
                      onChange={(event) => setPlaylistSourceName(event.target.value)}
                      placeholder="Starter Package"
                    />
                  </label>

                  <label className="wa-row">
                    <span className="wa-label">URL плейлиста (M3U / M3U8)</span>
                    <input
                      className="wa-input"
                      value={playlistUrl}
                      onChange={(event) => setPlaylistUrl(event.target.value)}
                      placeholder="https://example.com/playlist.m3u8"
                    />
                  </label>

                  <div className="wa-row wa-row--actions">
                    <span className="wa-label">Действия</span>
                    <div className="wa-actions">
                      <button type="button" className="wa-btn wa-btn--primary" onClick={() => void savePlaylist()} disabled={playlistBusy}>
                        {playlistBusy ? 'Сохранение...' : 'Добавить базовый плейлист'}
                      </button>
                      <button
                        type="button"
                        className="wa-btn"
                        onClick={() => void loadPlaylistWorkspace(undefined, true)}
                        disabled={playlistBusy}
                      >
                        {playlistBusy ? 'Проверка...' : 'Обновить данные'}
                      </button>
                    </div>
                  </div>

                  <div className="wa-base-playlists-status">
                    <article className="wa-base-playlists-stat-card">
                      <p className="wa-base-playlists-stat-label">Базовых источников</p>
                      <p className="wa-base-playlists-stat-value">{playlistStatus?.basePlaylistsCount ?? 0}</p>
                    </article>
                    <article className="wa-base-playlists-stat-card">
                      <p className="wa-base-playlists-stat-label">Каналов (объединено)</p>
                      <p className="wa-base-playlists-stat-value">{playlistStatus?.channelsCount ?? 0}</p>
                    </article>
                    <article className="wa-base-playlists-stat-card">
                      <p className="wa-base-playlists-stat-label">Последнее обновление</p>
                      <p className="wa-base-playlists-stat-value">{formatDateTime(playlistStatus?.cacheUpdatedAt ?? null)}</p>
                    </article>
                    <article className="wa-base-playlists-stat-card">
                      <p className="wa-base-playlists-stat-label">Активный режим</p>
                      <p className="wa-base-playlists-stat-value">
                        {playlistStatus?.activeMode === 'custom'
                          ? `Пользовательский: ${playlistStatus.activeCustomPlaylistName || 'без названия'}`
                          : 'Исходный плейлист'}
                      </p>
                    </article>
                    <article className="wa-base-playlists-stat-card">
                      <p className="wa-base-playlists-stat-label">Активных каналов в плеере</p>
                      <p className="wa-base-playlists-stat-value">{playlistStatus?.activeChannelsCount ?? 0}</p>
                    </article>
                  </div>

                  {playlistStatus?.sourceLastError ? (
                    <p className="wa-base-playlists-error">Ошибка источника: {playlistStatus.sourceLastError}</p>
                  ) : null}

                  <section className="wa-base-playlists-panel">
                    <h3 className="wa-base-playlists-panel-title">Базовые плейлисты</h3>
                    {basePlaylists.length === 0 ? (
                      <p className="wa-empty">Пока нет базовых плейлистов.</p>
                    ) : (
                      <div className="wa-base-playlists-custom-list">
                        {basePlaylists.map((playlist) => (
                          <article key={playlist.id} className="wa-base-playlists-custom-item">
                            <p className="wa-base-playlists-custom-item-name">{playlist.name}</p>
                            <p className="wa-base-playlists-custom-item-meta">{playlist.url}</p>
                            <p className="wa-base-playlists-custom-item-meta">
                              каналов: {playlist.channelsCount} | обновлено: {formatDateTime(playlist.cacheUpdatedAt)}
                            </p>
                            <div className="wa-actions">
                              <button type="button" className="wa-btn" onClick={() => void refreshBasePlaylist(playlist.id, playlist.name)} disabled={playlistBusy}>
                                Обновить
                              </button>
                              <button type="button" className="wa-btn" onClick={() => void renameBasePlaylist(playlist)} disabled={playlistBusy}>
                                Переименовать
                              </button>
                              <button type="button" className="wa-btn" onClick={() => void updateBasePlaylistUrl(playlist)} disabled={playlistBusy}>
                                Сменить URL
                              </button>
                              <button type="button" className="wa-btn wa-btn--ghost" onClick={() => void deleteBasePlaylist(playlist)} disabled={playlistBusy}>
                                Удалить
                              </button>
                            </div>
                            {playlist.lastError ? (
                              <p className="wa-base-playlists-error">Ошибка: {playlist.lastError}</p>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <div className="wa-base-playlists-manager">
                    <section className="wa-base-playlists-panel">
                      <h3 className="wa-base-playlists-panel-title">Пользовательские плейлисты</h3>

                      <label className="wa-row">
                        <span className="wa-label">Новый плейлист</span>
                        <input
                          className="wa-input"
                          value={newCustomPlaylistName}
                          onChange={(event) => setNewCustomPlaylistName(event.target.value)}
                          placeholder="Favorites RU"
                        />
                      </label>

                      <div className="wa-row wa-row--actions">
                        <span className="wa-label">Операции</span>
                        <div className="wa-actions">
                          <button type="button" className="wa-btn wa-btn--primary" onClick={() => void createCustomPlaylist()} disabled={playlistBusy}>
                            Создать
                          </button>
                          <button type="button" className="wa-btn" onClick={() => void loadPlaylistWorkspace(undefined, true)} disabled={playlistBusy}>
                            Обновить
                          </button>
                          <button type="button" className="wa-btn" onClick={() => void activateSourcePlaylist()} disabled={playlistBusy}>
                            Активировать исходный
                          </button>
                        </div>
                      </div>

                      {customPlaylists.length === 0 ? (
                        <p className="wa-empty">Пока нет пользовательских плейлистов.</p>
                      ) : (
                        <div className="wa-base-playlists-custom-list">
                          {customPlaylists.map((playlist) => (
                            <button
                              key={playlist.id}
                              type="button"
                              className={
                                playlist.id === selectedCustomPlaylistId
                                  ? 'wa-base-playlists-custom-item is-active'
                                  : 'wa-base-playlists-custom-item'
                              }
                              onClick={() => void loadCustomPlaylistById(playlist.id)}
                              disabled={playlistBusy}
                            >
                              <p className="wa-base-playlists-custom-item-name">{playlist.name}</p>
                              <p className="wa-base-playlists-custom-item-meta">
                                каналов: {playlist.channelsCount} | {playlist.isActive ? 'активен' : 'не активен'}
                              </p>
                              <p className="wa-base-playlists-custom-item-meta">
                                источники: {playlist.sourcePlaylistNames.length > 0 ? playlist.sourcePlaylistNames.join(', ') : '-'}
                              </p>
                            </button>
                          ))}
                        </div>
                      )}

                      {selectedCustomPlaylist ? (
                        <div className="wa-base-playlists-editor">
                          <label className="wa-row">
                            <span className="wa-label">Название</span>
                            <input
                              className="wa-input"
                              value={selectedCustomPlaylistName}
                              onChange={(event) => setSelectedCustomPlaylistName(event.target.value)}
                              placeholder="Playlist name"
                            />
                          </label>

                          <div className="wa-row wa-row--actions">
                            <span className="wa-label">Управление</span>
                            <div className="wa-actions">
                              <button type="button" className="wa-btn" onClick={() => void renameSelectedCustomPlaylist()} disabled={playlistBusy}>
                                Переименовать
                              </button>
                              <button type="button" className="wa-btn wa-btn--ghost" onClick={() => void deleteSelectedCustomPlaylist()} disabled={playlistBusy}>
                                Удалить
                              </button>
                              <button type="button" className="wa-btn wa-btn--primary" onClick={() => void saveCustomPlaylistDraft()} disabled={playlistBusy}>
                                Сохранить каналы
                              </button>
                              <button
                                type="button"
                                className="wa-btn"
                                onClick={() => setCustomDraftChannelIds(customSavedChannelIds)}
                                disabled={playlistBusy || !hasCustomDraftChanges}
                              >
                                Отменить изменения
                              </button>
                              <button type="button" className="wa-btn" onClick={() => void activateSelectedCustomPlaylist()} disabled={playlistBusy}>
                                Активировать
                              </button>
                            </div>
                          </div>

                          <label className="wa-row">
                            <span className="wa-label">Клонировать как</span>
                            <input
                              className="wa-input"
                              value={cloneCustomPlaylistName}
                              onChange={(event) => setCloneCustomPlaylistName(event.target.value)}
                              placeholder="Custom copy"
                            />
                          </label>
                          <div className="wa-row wa-row--actions">
                            <span className="wa-label">Копия</span>
                            <div className="wa-actions">
                              <button type="button" className="wa-btn" onClick={() => void cloneCurrentCustomPlaylist()} disabled={playlistBusy}>
                                Создать копию
                              </button>
                            </div>
                          </div>

                          <p className="wa-base-playlists-meta">
                            Каналов в черновике: {customDraftChannels.length}
                            {hasCustomDraftChanges ? ' (есть несохраненные изменения)' : ''}
                          </p>
                          <p className="wa-base-playlists-meta">
                            Источники текущего custom: {selectedCustomPlaylist.sourcePlaylistNames.length > 0 ? selectedCustomPlaylist.sourcePlaylistNames.join(', ') : '-'}
                          </p>

                          {customDraftChannels.length === 0 ? (
                            <p className="wa-empty">В этом плейлисте пока нет каналов.</p>
                          ) : (
                            <div className="wa-base-playlists-draft-list">
                              {customDraftChannels.map((channel, index) => (
                                <div key={channel.id} className="wa-base-playlists-draft-item">
                                  <div className="wa-base-playlists-draft-main">
                                    <p className="wa-base-playlists-draft-name">{index + 1}. {channel.name}</p>
                                    <p className="wa-base-playlists-draft-meta">
                                      {channel.group || 'без группы'} | {channel.tvgId || '-'}
                                    </p>
                                  </div>
                                  <div className="wa-base-playlists-draft-actions">
                                    <button type="button" className="wa-btn" onClick={() => moveDraftChannel(index, -1)} disabled={playlistBusy || index === 0}>
                                      Вверх
                                    </button>
                                    <button
                                      type="button"
                                      className="wa-btn"
                                      onClick={() => moveDraftChannel(index, 1)}
                                      disabled={playlistBusy || index === customDraftChannels.length - 1}
                                    >
                                      Вниз
                                    </button>
                                    <button type="button" className="wa-btn wa-btn--ghost" onClick={() => removeDraftChannel(channel.id)} disabled={playlistBusy}>
                                      Убрать
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </section>

                    <section className="wa-base-playlists-panel">
                      <h3 className="wa-base-playlists-panel-title">Каналы из базовых плейлистов</h3>

                      <label className="wa-row">
                        <span className="wa-label">Поиск</span>
                        <input
                          className="wa-input"
                          value={playlistSourceSearch}
                          onChange={(event) => setPlaylistSourceSearch(event.target.value)}
                          placeholder="search channel by name, group or tvg-id"
                        />
                      </label>

                      <div className="wa-row wa-row--actions">
                        <span className="wa-label">Выбор</span>
                        <div className="wa-actions">
                          <button type="button" className="wa-btn" onClick={selectAllFilteredSourceChannels} disabled={playlistBusy || filteredSourceChannels.length === 0}>
                            Выбрать все
                          </button>
                          <button type="button" className="wa-btn" onClick={clearSourceChannelSelection} disabled={playlistBusy || selectedSourceChannelIds.length === 0}>
                            Снять выбор
                          </button>
                          <button
                            type="button"
                            className="wa-btn wa-btn--primary"
                            onClick={addSelectedChannelsToCustomDraft}
                            disabled={playlistBusy || selectedSourceChannelIds.length === 0 || !selectedCustomPlaylistId}
                          >
                            Добавить в выбранный плейлист
                          </button>
                        </div>
                      </div>

                      <p className="wa-base-playlists-meta">
                        Найдено каналов: {filteredSourceChannels.length}. Выбрано: {selectedSourceChannelIds.length}.
                      </p>

                      {filteredSourceChannels.length === 0 ? (
                        <p className="wa-empty">Каналы не найдены. Проверьте URL источника и обновите данные.</p>
                      ) : (
                        <div className="wa-base-playlists-source-list">
                          {filteredSourceChannels.map((channel) => {
                            const isSelected = selectedSourceChannelIds.includes(channel.id);
                            return (
                              <label key={channel.id} className={isSelected ? 'wa-base-playlists-source-item is-selected' : 'wa-base-playlists-source-item'}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSourceChannelSelection(channel.id)}
                                  disabled={playlistBusy}
                                />
                                <div className="wa-base-playlists-source-item-main">
                                  <p className="wa-base-playlists-source-item-name">{channel.position}. {channel.name}</p>
                                  <p className="wa-base-playlists-source-item-meta">
                                    {channel.group || 'без группы'} | {channel.tvgId || '-'} | {channel.sourcePlaylistNames.join(', ')}
                                  </p>
                                </div>
                                {channel.logo ? (
                                  <img
                                    src={channel.logo}
                                    alt={channel.name}
                                    className="wa-base-playlists-source-item-logo"
                                    loading="lazy"
                                  />
                                ) : (
                                  <span className="wa-base-playlists-source-item-fallback">TV</span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  </div>
                </>
              ) : (
                <div className="wa-base-playlists-empty">
                  <p className="wa-base-playlists-empty-text">Для управления плейлистом нужен вход администратора.</p>
                  <button type="button" className="wa-base-auth-btn wa-base-auth-btn--primary" onClick={openLandingAuth}>
                    Вход администратора
                  </button>
                </div>
              )}
            </section>
          ) : landingSubscribersPageOpen ? (
            <section className="wa-base-subscribers" aria-label="Абоненты">
              <div className="wa-base-subscribers-head">
                <h2 className="wa-base-subscribers-title">Абоненты</h2>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--ghost"
                  onClick={openLandingHome}
                >
                  На главную
                </button>
              </div>
              <p className="wa-base-subscribers-text">
                Отдельная страница регистрации абонентов. Админ-панель остается отдельной и открывается только кнопкой
                сверху справа.
              </p>
              {editingClientId ? (
                <p className="wa-base-subscribers-text">
                  Редактирование абонента: <strong>{clientLastName || '-'} {clientFirstName || '-'}</strong>
                </p>
              ) : null}

              {token ? (
                <div className="wa-base-subscribers-form">
                  <label className="wa-row">
                    <span className="wa-label">Имя</span>
                    <input
                      className="wa-input"
                      value={clientFirstName}
                      onChange={(event) => setClientFirstName(event.target.value)}
                      placeholder="John"
                    />
                  </label>
                  <label className="wa-row">
                    <span className="wa-label">Фамилия</span>
                    <input
                      className="wa-input"
                      value={clientLastName}
                      onChange={(event) => setClientLastName(event.target.value)}
                      placeholder="Smith"
                    />
                  </label>
                  <label className="wa-row">
                    <span className="wa-label">Телефон</span>
                    <input
                      className="wa-input"
                      value={clientPhone}
                      onChange={(event) => setClientPhone(event.target.value)}
                      placeholder="+373 60 123 456"
                    />
                  </label>
                  <label className="wa-row">
                    <span className="wa-label">Адрес</span>
                    <input
                      className="wa-input"
                      value={clientAddress}
                      onChange={(event) => setClientAddress(event.target.value)}
                      placeholder="City, street, house"
                    />
                  </label>
                  <label className="wa-row">
                    <span className="wa-label">Устройств</span>
                    <input
                      className="wa-input"
                      value={clientDevicesAllowed}
                      onChange={(event) => setClientDevicesAllowed(event.target.value)}
                      placeholder="1"
                    />
                  </label>
                  <div className="wa-row wa-row--actions">
                    <span className="wa-label">Действия</span>
                    <div className="wa-actions">
                      {editingClientId ? (
                        <>
                          <button type="button" className="wa-btn wa-btn--primary" onClick={() => void saveEditedClient()}>
                            Сохранить изменения
                          </button>
                          <button type="button" className="wa-btn" onClick={cancelEditClient}>
                            Отмена
                          </button>
                          {selectedClient ? (
                            <button
                              type="button"
                              className="wa-btn wa-btn--ghost"
                              onClick={() => void deleteClient(selectedClient)}
                            >
                              Удалить абонента
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <button type="button" className="wa-btn wa-btn--primary" onClick={() => void createClient()}>
                          Зарегистрировать абонента
                        </button>
                      )}
                      <button type="button" className="wa-btn" onClick={() => void loadClients()} disabled={clientBusy}>
                        {clientBusy ? 'Обновление...' : 'Обновить список'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="wa-base-subscribers-empty">
                  <p className="wa-base-subscribers-empty-text">
                    Для регистрации абонента нужен вход администратора.
                  </p>
                  <button type="button" className="wa-base-auth-btn wa-base-auth-btn--primary" onClick={openLandingAuth}>
                    Вход администратора
                  </button>
                </div>
              )}

              {token ? (
                <div className="wa-base-subscribers-list">
                  <p className="wa-base-subscribers-list-title">Список абонентов (нажмите для редактирования)</p>
                  {clients.length === 0 ? (
                    <p className="wa-empty">Список абонентов пока пуст.</p>
                  ) : (
                    <div className="wa-base-subscribers-list-grid">
                      {clients.map((client) => (
                        <button
                          key={client.id}
                          type="button"
                          className={
                            client.id === editingClientId
                              ? 'wa-base-subscribers-item is-active'
                              : 'wa-base-subscribers-item'
                          }
                          onClick={() => startEditClient(client)}
                        >
                          <p className="wa-base-subscribers-item-name">
                            {client.lastName} {client.firstName}
                          </p>
                          <p className="wa-base-subscribers-item-meta">
                            {client.phone} | устройств: {client.pairedDevices}/{client.devicesAllowed}
                          </p>
                          <p className="wa-base-subscribers-item-meta">{client.address}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : (
            <>
              <main className="wa-base-grid">
                <button
                  type="button"
                  className={landingActiveTile === 'playlists' ? 'wa-base-tile is-active' : 'wa-base-tile'}
                  onClick={openPlaylistsPage}
                >
                  <span className="wa-base-icon wa-base-icon--playlists" aria-hidden="true" />
                  <span className="wa-base-tile-label">ваши плейлисты</span>
                </button>

                <button
                  type="button"
                  className={landingActiveTile === 'devices' ? 'wa-base-tile is-active' : 'wa-base-tile'}
                  onClick={() => openLandingTile('devices')}
                >
                  <span className="wa-base-icon wa-base-icon--devices" aria-hidden="true" />
                  <span className="wa-base-tile-label">ваши устройства</span>
                </button>

                <button
                  type="button"
                  className={landingActiveTile === 'cabinet' ? 'wa-base-tile is-active' : 'wa-base-tile'}
                  onClick={openSubscribersPage}
                >
                  <span className="wa-base-icon wa-base-icon--cabinet" aria-hidden="true" />
                  <span className="wa-base-tile-label">абоненты</span>
                </button>

                <button
                  type="button"
                  className={landingActiveTile === 'how' ? 'wa-base-tile is-active' : 'wa-base-tile'}
                  onClick={() => openLandingTile('how')}
                >
                  <span className="wa-base-icon wa-base-icon--info" aria-hidden="true" />
                  <span className="wa-base-tile-label">как это работает</span>
                </button>
              </main>

              {landingActiveTile === 'devices' ? (
                <section className="wa-base-devices" aria-label="Устройства">
                  <h2 className="wa-base-devices-title">Устройства и Pair</h2>
                  <p className="wa-base-devices-text">
                    Введите код с телефона/TV, выберите абонента и плейлист для нового устройства.
                  </p>

                  {token ? (
                    <>
                      <div className="wa-base-devices-form">
                        <label className="wa-row">
                          <span className="wa-label">Абонент</span>
                          <select
                            className="wa-input"
                            value={selectedClientId}
                            onChange={(event) => setSelectedClientId(event.target.value)}
                          >
                            <option value="">Выберите абонента</option>
                            {clients.map((client) => (
                              <option key={client.id} value={client.id}>
                                {client.lastName} {client.firstName} ({client.phone})
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="wa-row">
                          <span className="wa-label">Код Pair</span>
                          <input
                            className="wa-input"
                            value={pairCode}
                            onChange={(event) => setPairCode(event.target.value.toUpperCase())}
                            placeholder="A1B2C3"
                            maxLength={8}
                          />
                        </label>

                        <label className="wa-row">
                          <span className="wa-label">Плейлист для нового устройства</span>
                          <select
                            className="wa-input"
                            value={pairPlaylistMode}
                            onChange={(event) => setPairPlaylistMode(event.target.value as DevicePlaylistMode)}
                          >
                            <option value="GLOBAL">GLOBAL (как в настройке системы)</option>
                            <option value="SOURCE">SOURCE (только исходный список)</option>
                            <option value="CUSTOM">CUSTOM (выбрать из списка)</option>
                          </select>
                        </label>

                        {pairPlaylistMode === 'CUSTOM' ? (
                          <label className="wa-row">
                            <span className="wa-label">Custom-плейлист</span>
                            <select
                              className="wa-input"
                              value={pairCustomPlaylistId}
                              onChange={(event) => setPairCustomPlaylistId(event.target.value)}
                            >
                              <option value="">Выберите custom-плейлист</option>
                              {customPlaylists.map((playlist) => (
                                <option key={playlist.id} value={playlist.id}>
                                  {playlist.name} ({playlist.channelsCount} каналов)
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        <div className="wa-row wa-row--actions">
                          <span className="wa-label">Действия</span>
                          <div className="wa-actions">
                            <button type="button" className="wa-btn wa-btn--primary" onClick={() => void confirmPair()}>
                              Подтвердить Pair
                            </button>
                            <button
                              type="button"
                              className="wa-btn"
                              onClick={() => void loadDevices()}
                              disabled={devicesBusy}
                            >
                              {devicesBusy ? 'Обновление...' : 'Обновить устройства'}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="wa-base-devices-list">
                        <p className="wa-base-devices-list-title">Подключенные устройства</p>
                        {pairedDevices.length === 0 ? (
                          <p className="wa-empty">Пока нет подключенных устройств.</p>
                        ) : (
                          <div className="wa-base-devices-list-grid">
                            {pairedDevices.map((device) => {
                              const draft = getDevicePlaylistDraft(device);
                              const hasDraftChanges =
                                draft.mode !== device.playlistMode ||
                                (draft.mode === 'CUSTOM'
                                  ? draft.customPlaylistId !== (device.customPlaylistId ?? '')
                                  : false);

                              return (
                                <article key={device.id} className="wa-base-devices-item">
                                  <p className="wa-base-devices-item-name">{device.name}</p>
                                  <p className="wa-base-devices-item-meta">
                                    {device.platform} | {device.clientName || 'без абонента'}
                                  </p>
                                  <p className="wa-base-devices-item-meta">
                                    Pair: {formatDateTime(device.pairedAt)} | Online: {formatDateTime(device.lastSeenAt)}
                                  </p>
                                  <p className="wa-base-devices-item-meta">
                                    Текущий режим: {device.playlistMode}
                                    {device.customPlaylistName ? ` (${device.customPlaylistName})` : ''}
                                  </p>

                                  <label className="wa-row">
                                    <span className="wa-label">Режим</span>
                                    <select
                                      className="wa-input"
                                      value={draft.mode}
                                      onChange={(event) =>
                                        setDevicePlaylistModeDraft(
                                          device.id,
                                          event.target.value as DevicePlaylistMode
                                        )
                                      }
                                    >
                                      <option value="GLOBAL">GLOBAL</option>
                                      <option value="SOURCE">SOURCE</option>
                                      <option value="CUSTOM">CUSTOM</option>
                                    </select>
                                  </label>

                                  {draft.mode === 'CUSTOM' ? (
                                    <label className="wa-row">
                                      <span className="wa-label">Custom-плейлист</span>
                                      <select
                                        className="wa-input"
                                        value={draft.customPlaylistId}
                                        onChange={(event) =>
                                          setDeviceCustomPlaylistDraft(device.id, event.target.value)
                                        }
                                      >
                                        <option value="">Выберите custom-плейлист</option>
                                        {customPlaylists.map((playlist) => (
                                          <option key={playlist.id} value={playlist.id}>
                                            {playlist.name} ({playlist.channelsCount} каналов)
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  ) : null}

                                  <div className="wa-actions">
                                    <button
                                      type="button"
                                      className="wa-btn wa-btn--primary"
                                      onClick={() => void saveDevicePlaylistAssignment(device)}
                                      disabled={devicesBusy || !hasDraftChanges}
                                    >
                                      Сохранить
                                    </button>
                                  </div>
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="wa-base-devices-empty">
                      <p className="wa-base-devices-empty-text">Для управления устройствами нужен вход администратора.</p>
                      <button type="button" className="wa-base-auth-btn wa-base-auth-btn--primary" onClick={openLandingAuth}>
                        Вход администратора
                      </button>
                    </div>
                  )}
                </section>
              ) : null}

              {landingActiveTile === 'how' ? (
                <section className="wa-base-guide" aria-label="README как это работает">
                  <h2 className="wa-base-guide-title">README: как это работает</h2>
                  <p className="wa-base-guide-text">
                    Ниже быстрый сценарий запуска сервиса: от источников до привязки устройств клиента.
                  </p>

                  <ol className="wa-base-guide-list">
                    <li>
                      <strong>Войти как администратор.</strong> Нажмите «Вход администратора», введите email/пароль и
                      откройте админ-панель.
                    </li>
                    <li>
                      <strong>Добавить источники.</strong> В блоке источников укажите рабочий URL плейлиста
                      (M3U/провайдер). EPG подгружается автоматически из epg.ott-play.com.
                    </li>
                    <li>
                      <strong>Добавить клиента.</strong> Заполните имя, фамилию, телефон, адрес и лимит устройств
                      (например 1, 2, 3).
                    </li>
                    <li>
                      <strong>Сделать Pair with Code.</strong> Клиент открывает плеер на устройстве и сообщает код.
                      В админке выберите клиента, введите код и нажмите подтверждение.
                    </li>
                    <li>
                      <strong>Повторная привязка.</strong> Для того же клиента можно делать привязку много раз, пока не
                      достигнут лимит устройств. Лимит можно изменить в карточке клиента.
                    </li>
                    <li>
                      <strong>Контроль и поддержка.</strong> Проверяйте историю привязок, активные устройства и статус
                      запросов. Если нужно, удаляйте клиента или корректируйте лимит.
                    </li>
                  </ol>
                </section>
              ) : null}
            </>
          )}
        </div>

        {landingAuthOpen ? (
          <div className="wa-base-auth-overlay" role="presentation" onClick={() => setLandingAuthOpen(false)}>
            <div className="wa-base-auth-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <p className="wa-base-auth-title">Вход администратора</p>
              <p className="wa-base-auth-subtitle">
                Введите данные администратора для входа в панель.
              </p>

              <label className="wa-base-auth-label">
                <span>Эл. почта</span>
                <input
                  className="wa-base-auth-input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="username"
                />
              </label>

              <label className="wa-base-auth-label">
                <span>Пароль</span>
                <input
                  className="wa-base-auth-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="********"
                  autoComplete="current-password"
                />
              </label>

              <label className="wa-base-auth-remember">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                <span>Запомнить меня на этом устройстве</span>
              </label>

              <button type="button" className="wa-base-auth-forgot" onClick={openForgotPasswordModal}>
                Забыл пароль?
              </button>

              <div className="wa-base-auth-actions">
                <button type="button" className="wa-base-auth-btn" onClick={openRegisterModal}>
                  Регистрация
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void callAuth()}
                >
                  Войти
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--ghost"
                  onClick={() => setLandingAuthOpen(false)}
                >
                  Закрыть
                </button>
              </div>

              <p
                className={
                  statusTone === 'error'
                    ? 'wa-base-auth-status is-error'
                    : statusTone === 'ok'
                      ? 'wa-base-auth-status is-ok'
                      : 'wa-base-auth-status'
                }
              >
                {statusMessage}
              </p>
            </div>
          </div>
        ) : null}

        {registerModalOpen ? (
          <div className="wa-base-auth-overlay" role="presentation" onClick={closeRegisterModal}>
            <div className="wa-base-auth-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <p className="wa-base-auth-title">Регистрация администратора</p>
              <p className="wa-base-auth-subtitle">
                Создайте новый аккаунт. На почту придет 8-значный код подтверждения. Повторная отправка доступна раз в 1 минуту.
              </p>

              <label className="wa-base-auth-label">
                <span>Эл. почта</span>
                <input
                  className="wa-base-auth-input"
                  value={registerEmail}
                  onChange={(event) => setRegisterEmail(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="email"
                />
              </label>

              <label className="wa-base-auth-label">
                <span>Пароль</span>
                <input
                  className="wa-base-auth-input"
                  type="password"
                  value={registerPassword}
                  onChange={(event) => setRegisterPassword(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                />
              </label>

              <label className="wa-base-auth-label">
                <span>Подтверждение пароля</span>
                <input
                  className="wa-base-auth-input"
                  type="password"
                  value={registerPasswordConfirm}
                  onChange={(event) => setRegisterPasswordConfirm(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                />
              </label>

              <label className="wa-base-auth-label">
                <span>Код подтверждения</span>
                <input
                  className="wa-base-auth-input"
                  value={registerCode}
                  onChange={(event) => setRegisterCode(event.target.value)}
                  placeholder="12345678"
                  inputMode="numeric"
                  maxLength={8}
                />
              </label>

              <div className="wa-base-auth-actions">
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void submitRegistrationForm()}
                >
                  Зарегистрироваться
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn"
                  onClick={() => void resendRegistrationForm()}
                  disabled={registerResendCooldownSec > 0}
                >
                  {registerResendCooldownSec > 0
                    ? `Повторно отправить (${formatCountdown(registerResendCooldownSec)})`
                    : 'Повторно отправить письмо'}
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void confirmRegistrationForm()}
                >
                  Подтвердить код
                </button>
                <button type="button" className="wa-base-auth-btn wa-base-auth-btn--ghost" onClick={closeRegisterModal}>
                  Назад
                </button>
              </div>

              <p
                className={
                  statusTone === 'error'
                    ? 'wa-base-auth-status is-error'
                    : statusTone === 'ok'
                      ? 'wa-base-auth-status is-ok'
                      : 'wa-base-auth-status'
                }
              >
                {statusMessage}
              </p>
            </div>
          </div>
        ) : null}

        {forgotModalOpen ? (
          <div className="wa-base-auth-overlay" role="presentation" onClick={closeForgotPasswordModal}>
            <div className="wa-base-auth-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <p className="wa-base-auth-title">Восстановление доступа</p>
              <p className="wa-base-auth-subtitle">
                Укажите email администратора. Мы отправим письмо со ссылкой для восстановления пароля.
              </p>

              <label className="wa-base-auth-label">
                <span>Эл. почта</span>
                <input
                  className="wa-base-auth-input"
                  value={resetEmail}
                  onChange={(event) => setResetEmail(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="email"
                />
              </label>

              <div className="wa-base-auth-actions">
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void requestPasswordReset()}
                >
                  Отправить письмо
                </button>
                <button type="button" className="wa-base-auth-btn wa-base-auth-btn--ghost" onClick={closeForgotPasswordModal}>
                  Назад
                </button>
              </div>

              <p
                className={
                  statusTone === 'error'
                    ? 'wa-base-auth-status is-error'
                    : statusTone === 'ok'
                      ? 'wa-base-auth-status is-ok'
                      : 'wa-base-auth-status'
                }
              >
                {statusMessage}
              </p>
            </div>
          </div>
        ) : null}

        {resetModalOpen ? (
          <div className="wa-base-auth-overlay" role="presentation" onClick={closeResetModal}>
            <div className="wa-base-auth-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <p className="wa-base-auth-title">Восстановление пароля</p>
              <p className="wa-base-auth-subtitle">
                Введите новый пароль для аккаунта администратора и сохраните изменения.
              </p>

              <label className="wa-base-auth-label">
                <span>Новый пароль</span>
                <input
                  className="wa-base-auth-input"
                  type="password"
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                />
              </label>

              <label className="wa-base-auth-label">
                <span>Повторите новый пароль</span>
                <input
                  className="wa-base-auth-input"
                  type="password"
                  value={resetPasswordConfirm}
                  onChange={(event) => setResetPasswordConfirm(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                />
              </label>

              <div className="wa-base-auth-actions">
                <button type="button" className="wa-base-auth-btn wa-base-auth-btn--primary" onClick={() => void submitPasswordReset()}>
                  Сохранить пароль
                </button>
                <button type="button" className="wa-base-auth-btn wa-base-auth-btn--ghost" onClick={closeResetModal}>
                  Отмена
                </button>
              </div>

              <p
                className={
                  statusTone === 'error'
                    ? 'wa-base-auth-status is-error'
                    : statusTone === 'ok'
                      ? 'wa-base-auth-status is-ok'
                      : 'wa-base-auth-status'
                }
              >
                {statusMessage}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wa-ott">
      <div className="wa-shell">
        <header className="wa-header">
          <div>
            <h1>AccountTV Админ</h1>
            <p className="wa-subtitle">Панель управления администраторами и системным доступом.</p>
          </div>
          <div className="wa-header-right">
            <p className="wa-clock">{clockLabel}</p>
            <p className={token ? 'wa-session wa-session--active' : 'wa-session wa-session--idle'}>
              {token ? 'Сессия активна' : 'Нет сессии'}
            </p>
            <div className="wa-header-actions">
              <button type="button" className="wa-btn" onClick={() => setDashboardOpen(false)}>
                На главную
              </button>
              <button type="button" className="wa-btn wa-btn--ghost" onClick={logout}>
                Выйти
              </button>
            </div>
          </div>
        </header>

        <div className="wa-main">
          <section className="wa-left">
            <h2 className="wa-section-title">Администраторы</h2>

            <label
              className="wa-row"
              onFocus={() => setFocusTopic('admins')}
              onMouseEnter={() => setFocusTopic('admins')}
            >
              <span className="wa-label">Эл. почта администратора</span>
              <input
                className="wa-input"
                value={newAdminEmail}
                onChange={(event) => setNewAdminEmail(event.target.value)}
                placeholder="admin2@example.com"
              />
            </label>

            <label
              className="wa-row"
              onFocus={() => setFocusTopic('admins')}
              onMouseEnter={() => setFocusTopic('admins')}
            >
              <span className="wa-label">Пароль admin</span>
              <input
                className="wa-input"
                type="password"
                value={newAdminPassword}
                onChange={(event) => setNewAdminPassword(event.target.value)}
                placeholder="minimum 8 characters"
              />
            </label>

            <label
              className="wa-row"
              onFocus={() => setFocusTopic('admins')}
              onMouseEnter={() => setFocusTopic('admins')}
            >
              <span className="wa-label">Код подтверждения</span>
              <input
                className="wa-input"
                value={newAdminCode}
                onChange={(event) => setNewAdminCode(event.target.value)}
                placeholder="8 digits from email"
                inputMode="numeric"
                maxLength={8}
              />
            </label>

            <div
              className="wa-row wa-row--actions"
              onFocus={() => setFocusTopic('admins')}
              onMouseEnter={() => setFocusTopic('admins')}
            >
              <span className="wa-label">Действия администратора</span>
              <div className="wa-actions">
                <button type="button" className="wa-btn wa-btn--primary" onClick={() => void requestNewAdminCode()}>
                  Отправить код
                </button>
                <button
                  type="button"
                  className="wa-btn"
                  onClick={() => void resendNewAdminCode()}
                  disabled={newAdminResendCooldownSec > 0}
                >
                  {newAdminResendCooldownSec > 0
                    ? `Повторно отправить (${formatCountdown(newAdminResendCooldownSec)})`
                    : 'Повторно отправить код'}
                </button>
                <button type="button" className="wa-btn wa-btn--primary" onClick={() => void confirmNewAdminCode()}>
                  Подтвердить и добавить
                </button>
                <button type="button" className="wa-btn" onClick={() => void loadAdmins()} disabled={adminsBusy}>
                  {adminsBusy ? 'Обновление...' : 'Обновить админов'}
                </button>
              </div>
            </div>

            <div
              className="wa-admin-list"
              onFocus={() => setFocusTopic('admins')}
              onMouseEnter={() => setFocusTopic('admins')}
            >
              {admins.length === 0 ? (
                <p className="wa-empty">Администраторы отсутствуют.</p>
              ) : (
                admins.map((admin) => (
                  <article key={admin.id} className="wa-admin-item">
                    <p className="wa-admin-email">{admin.email}</p>
                    <p className="wa-admin-meta">Создан: {formatDateTime(admin.createdAt)}</p>
                    <div className="wa-actions">
                      <button
                        type="button"
                        className="wa-btn wa-btn--ghost"
                        onClick={() => void deleteAdmin(admin)}
                      >
                        Удалить админа
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <aside className="wa-right">
            <p className="wa-right-title">Статус</p>
            <p
              className={
                statusTone === 'error'
                  ? 'wa-status wa-status--error'
                  : statusTone === 'ok'
                    ? 'wa-status wa-status--ok'
                    : 'wa-status'
              }
              onMouseEnter={() => setFocusTopic('status')}
            >
              {statusMessage}
            </p>

            <p className="wa-help">{HELP_TEXT[focusTopic]}</p>

            <div className="wa-meta" onMouseEnter={() => setFocusTopic('api')}>
              <span className="wa-meta-label">API база</span>
              <strong className="wa-meta-value">{API_BASE}</strong>
            </div>

            <div className="wa-meta" onMouseEnter={() => setFocusTopic('admins')}>
              <span className="wa-meta-label">Администраторы</span>
              <strong className="wa-meta-value">{admins.length}</strong>
            </div>

            <div className="wa-meta" onMouseEnter={() => setFocusTopic('session')}>
              <span className="wa-meta-label">JWT токен</span>
              <strong className="wa-meta-value">{tokenStorageLabel}</strong>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};



