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
const PLAYLIST_FILE_MAX_BYTES = 2_000_000;
const EPG_GZIP_FILE_MAX_BYTES = 80_000_000;
const SUBSCRIBER_SOURCE_SELECTION_VALUE = 'SOURCE:';

type StatusTone = 'idle' | 'ok' | 'error';
type DevicePlaylistMode = 'GLOBAL' | 'SOURCE' | 'CUSTOM';
type AdminSortMode = 'newest' | 'oldest' | 'email';
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
  sourcePlaylistIds: string[];
  pairedDevices: number;
  createdAt: string;
  updatedAt: string;
}

interface FinalClientDraft {
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  devicesAllowed: string;
  sourcePlaylistIds: string[];
}
type FinalClientTextField = Exclude<keyof FinalClientDraft, 'sourcePlaylistIds'>;

interface PairedDeviceItem {
  id: string;
  name: string;
  platform: string;
  macAddress: string | null;
  fingerprint: string | null;
  ipAddress: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  clientId: string | null;
  clientName: string | null;
  playlistMode: DevicePlaylistMode;
  customPlaylistId: string | null;
  customPlaylistName: string | null;
  sourcePlaylistId: string | null;
  sourcePlaylistName: string | null;
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

interface EpgStatusItem {
  mode: string;
  sourceUrl: string | null;
  sourceLastIngestedAt: string | null;
  sourceLastError: string | null;
  sourceUpdatedAt: string | null;
  snapshotUpdatedAt: string | null;
  snapshotGeneratedAt: string | null;
  snapshotChannels: number;
  snapshotLastSuccessfulIngest: string | null;
}

interface EpgUploadResult {
  success: true;
  sourceUrl: string;
  fileName: string;
  snapshotGeneratedAt: string;
  snapshotChannels: number;
}

interface BasePlaylistItem {
  id: string;
  name: string;
  url: string;
  sourceType?: 'url' | 'file';
  fileName?: string | null;
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

interface PlaylistSelectionOption {
  value: string;
  label: string;
  group: 'source' | 'custom';
  mode: DevicePlaylistMode;
  playlistId: string;
}

interface AuditLogItem {
  id: string;
  action: string;
  method: string | null;
  path: string | null;
  entityType: string | null;
  entityId: string | null;
  success: boolean;
  statusCode: number | null;
  details: unknown;
  userId: string | null;
  userEmail: string | null;
  createdAt: string;
}

type AuditSection = 'registration' | 'playlists' | 'internal';
type AuditOutcome = 'success' | 'error';
type LandingTile = 'playlists' | 'devices' | 'cabinet' | 'how';
type StudioSection = 'admins' | 'forms' | 'playlists' | 'constructor' | 'account' | 'logs';
type AddMenuItem = 'playlist' | 'subscriber';
type PlaylistsSubMenuItem = 'base' | 'modified' | 'epg';

const HELP_TEXT: Record<FocusTopic, string> = {
  account:
    'Введите email и пароль администратора. Регистрация отправляет код подтверждения на Gmail, вход доступен после ввода кода.',
  admins:
    'Здесь вы управляете администраторами приложения. Для добавления отправьте код на email и подтвердите его (8 цифр).',
  clients:
    'Клиент добавляется один раз, затем выбирается для каждой новой привязки устройств.',
  pairing:
    'Введите код с плеера в форме абонента. Устройство привязывается к новому абоненту, а плейлист назначается в разделе абонентов.',
  history:
    'Журнал показывает действия администраторов: метод, endpoint, результат и время выполнения.',
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

const formatIdentityValue = (value: string | null): string => {
  const normalized = (value ?? '').trim();
  return normalized || '-';
};

const formatDeviceIdentity = (device: PairedDeviceItem): string => {
  const macLabel = formatIdentityValue(device.macAddress);
  const idLabel = formatIdentityValue(device.fingerprint);
  return `${device.platform} | MAC: ${macLabel} | ID: ${idLabel} | IP: ${formatIdentityValue(device.ipAddress)}`;
};

const sortClients = (rows: ClientItem[]): ClientItem[] => {
  return [...rows].sort((a, b) => {
    const left = `${a.lastName} ${a.firstName}`.trim();
    const right = `${b.lastName} ${b.firstName}`.trim();
    return left.localeCompare(right, 'ru', { sensitivity: 'base' });
  });
};

const normalizeStringArray = (rawValue: unknown): string[] => {
  if (!Array.isArray(rawValue)) {
    return [];
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const item of rawValue) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
};

const toFinalClientDraft = (client: ClientItem): FinalClientDraft => ({
  firstName: client.firstName,
  lastName: client.lastName,
  phone: client.phone,
  address: client.address,
  devicesAllowed: String(client.devicesAllowed),
  sourcePlaylistIds: [...client.sourcePlaylistIds]
});

const areFinalClientDraftsEqual = (left: FinalClientDraft | undefined, right: FinalClientDraft): boolean => {
  if (!left) {
    return false;
  }

  if (left.sourcePlaylistIds.length !== right.sourcePlaylistIds.length) {
    return false;
  }
  for (let index = 0; index < left.sourcePlaylistIds.length; index += 1) {
    if (left.sourcePlaylistIds[index] !== right.sourcePlaylistIds[index]) {
      return false;
    }
  }

  return (
    left.firstName === right.firstName &&
    left.lastName === right.lastName &&
    left.phone === right.phone &&
    left.address === right.address &&
    left.devicesAllowed === right.devicesAllowed
  );
};

const parseDateMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortAdminsByNewest = (rows: AdminItem[]): AdminItem[] => {
  return [...rows].sort((left, right) => {
    const byDate = parseDateMs(right.createdAt) - parseDateMs(left.createdAt);
    if (byDate !== 0) {
      return byDate;
    }
    return left.email.localeCompare(right.email, 'ru', { sensitivity: 'base' });
  });
};

const isEmailLike = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const validateAdminEmailRequired = (rawValue: string): string => {
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return 'Введите email нового администратора.';
  }
  if (!isEmailLike(normalized)) {
    return 'Введите корректный email нового администратора.';
  }
  return '';
};

const validateAdminPasswordRequired = (rawValue: string): string => {
  if (rawValue.trim().length < 8) {
    return 'Пароль нового администратора должен содержать минимум 8 символов.';
  }
  return '';
};

const validateAdminCodeRequired = (rawValue: string): string => {
  const normalized = rawValue.trim();
  if (!normalized) {
    return 'Введите код подтверждения.';
  }
  if (!/^\d{8}$/.test(normalized)) {
    return 'Введите 8-значный код нового администратора.';
  }
  return '';
};

const validateEmailRequired = (rawValue: string, requiredMessage: string, invalidMessage: string): string => {
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return requiredMessage;
  }
  if (!isEmailLike(normalized)) {
    return invalidMessage;
  }
  return '';
};

const validatePasswordMinLength = (rawValue: string, requiredMessage: string): string => {
  if (rawValue.trim().length < 8) {
    return requiredMessage;
  }
  return '';
};

const validatePasswordConfirm = (
  password: string,
  passwordConfirm: string,
  emptyMessage: string,
  mismatchMessage: string
): string => {
  if (!passwordConfirm) {
    return emptyMessage;
  }
  if (password !== passwordConfirm) {
    return mismatchMessage;
  }
  return '';
};

const validateCode8Digits = (rawValue: string, emptyMessage: string, invalidMessage: string): string => {
  const normalized = rawValue.trim();
  if (!normalized) {
    return emptyMessage;
  }
  if (!/^\d{8}$/.test(normalized)) {
    return invalidMessage;
  }
  return '';
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
  return '';
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

const formatAuditDetails = (details: unknown): string => {
  if (details === null || details === undefined) {
    return '-';
  }

  if (typeof details === 'string') {
    return details.length > 1000 ? `${details.slice(0, 1000)}...` : details;
  }

  try {
    const serialized = JSON.stringify(details, null, 2);
    return serialized.length > 1600 ? `${serialized.slice(0, 1600)}...` : serialized;
  } catch {
    return String(details);
  }
};

const getAuditIssueDescription = (details: unknown, fallback: string): string => {
  if (!details || typeof details !== 'object') {
    return fallback;
  }

  const source = details as Record<string, unknown>;
  const error = source.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }

  const result = source.result;
  if (result && typeof result === 'object') {
    const message = (result as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }

  return fallback;
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
  const [adminSearchQuery, setAdminSearchQuery] = useState('');
  const [adminSortMode, setAdminSortMode] = useState<AdminSortMode>('newest');
  const [copiedAdminEmail, setCopiedAdminEmail] = useState('');
  const [pendingAdminEmailForConfirm, setPendingAdminEmailForConfirm] = useState('');
  const [lastConfirmedAdminEmail, setLastConfirmedAdminEmail] = useState('');
  const [newAdminEmailError, setNewAdminEmailError] = useState('');
  const [newAdminPasswordError, setNewAdminPasswordError] = useState('');
  const [newAdminCodeError, setNewAdminCodeError] = useState('');
  const [loginEmailError, setLoginEmailError] = useState('');
  const [loginPasswordError, setLoginPasswordError] = useState('');
  const [registerEmailError, setRegisterEmailError] = useState('');
  const [registerPasswordError, setRegisterPasswordError] = useState('');
  const [registerPasswordConfirmError, setRegisterPasswordConfirmError] = useState('');
  const [registerCodeError, setRegisterCodeError] = useState('');
  const [forgotEmailError, setForgotEmailError] = useState('');
  const [resetPasswordError, setResetPasswordError] = useState('');
  const [resetPasswordConfirmError, setResetPasswordConfirmError] = useState('');

  const [clientFirstName, setClientFirstName] = useState('');
  const [clientLastName, setClientLastName] = useState('');
  const [clientPhone, setClientPhone] = useState('+373');
  const [clientAddress, setClientAddress] = useState('');
  const [clientDevicesAllowed, setClientDevicesAllowed] = useState('1');
  const [clientSourcePlaylistIds, setClientSourcePlaylistIds] = useState<string[]>([]);

  const [playlistSourceName, setPlaylistSourceName] = useState('');
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [playlistFile, setPlaylistFile] = useState<File | null>(null);
  const [playlistFileInputVersion, setPlaylistFileInputVersion] = useState(0);
  const [epgGzipFile, setEpgGzipFile] = useState<File | null>(null);
  const [epgFileInputVersion, setEpgFileInputVersion] = useState(0);
  const [epgSourceUrl, setEpgSourceUrl] = useState('');
  const [epgStatus, setEpgStatus] = useState<EpgStatusItem | null>(null);
  const [playlistStatus, setPlaylistStatus] = useState<PlaylistStatusItem | null>(null);
  const [basePlaylists, setBasePlaylists] = useState<BasePlaylistItem[]>([]);
  const [playlistChannels, setPlaylistChannels] = useState<PlaylistChannelItem[]>([]);
  const [customPlaylists, setCustomPlaylists] = useState<CustomPlaylistListItem[]>([]);
  const [selectedCustomPlaylistId, setSelectedCustomPlaylistId] = useState('');
  const [selectedCustomPlaylistName, setSelectedCustomPlaylistName] = useState('');
  const [newCustomPlaylistName, setNewCustomPlaylistName] = useState('');
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
  const [pairCode, setPairCode] = useState(() => getPairCodeFromUrl());
  const [pairPlaylistMode, setPairPlaylistMode] = useState<DevicePlaylistMode>('SOURCE');
  const [pairCustomPlaylistId, setPairCustomPlaylistId] = useState('');
  const [pairPlaylistSelection, setPairPlaylistSelection] = useState('');
  const [editingClientId, setEditingClientId] = useState('');

  const [statusMessage, setStatusMessage] = useState('Готово.');
  const [statusTone, setStatusTone] = useState<StatusTone>('idle');
  const [focusTopic, setFocusTopic] = useState<FocusTopic>('status');
  const [clockLabel, setClockLabel] = useState(() => formatClock());
  const [tokenRevision, setTokenRevision] = useState(0);
  const [clientBusy, setClientBusy] = useState(false);
  const [adminsBusy, setAdminsBusy] = useState(false);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [epgBusy, setEpgBusy] = useState(false);
  const [landingAuthOpen, setLandingAuthOpen] = useState(false);
  const [landingActiveTile, setLandingActiveTile] = useState<LandingTile>('how');
  const [landingMenuOpen, setLandingMenuOpen] = useState(false);
  const [landingPlaylistsPageOpen, setLandingPlaylistsPageOpen] = useState(false);
  const [landingSubscribersPageOpen, setLandingSubscribersPageOpen] = useState(false);
  const [studioSection, setStudioSection] = useState<StudioSection>('forms');
  const [addMenuItem, setAddMenuItem] = useState<AddMenuItem>('playlist');
  const [playlistsSubMenuItem, setPlaylistsSubMenuItem] = useState<PlaylistsSubMenuItem>('base');
  const [expandedFinalClientId, setExpandedFinalClientId] = useState('');
  const [finalClientDrafts, setFinalClientDrafts] = useState<Record<string, FinalClientDraft>>({});
  const [auditSection, setAuditSection] = useState<AuditSection>('registration');
  const [auditOutcome, setAuditOutcome] = useState<AuditOutcome>('error');
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [auditBusy, setAuditBusy] = useState(false);

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

  const pairedDevicesByClient = useMemo(() => {
    const byClientId = new Map<string, PairedDeviceItem[]>();
    const unassigned: PairedDeviceItem[] = [];

    for (const device of pairedDevices) {
      const clientId = device.clientId?.trim() ?? '';
      if (!clientId) {
        unassigned.push(device);
        continue;
      }

      const bucket = byClientId.get(clientId);
      if (bucket) {
        bucket.push(device);
      } else {
        byClientId.set(clientId, [device]);
      }
    }

    return { byClientId, unassigned };
  }, [pairedDevices]);

  const playlistChannelsById = useMemo(
    () => new Map(playlistChannels.map((channel) => [channel.id, channel] as const)),
    [playlistChannels]
  );

  const selectedCustomPlaylist = useMemo(
    () => customPlaylists.find((playlist) => playlist.id === selectedCustomPlaylistId) ?? null,
    [customPlaylists, selectedCustomPlaylistId]
  );

  const playlistSelectionOptions = useMemo<PlaylistSelectionOption[]>(() => {
    const sourceOptions: PlaylistSelectionOption[] = basePlaylists.map((playlist) => ({
      value: `SOURCE:${playlist.id}`,
      label: playlist.name,
      group: 'source',
      mode: 'SOURCE',
      playlistId: playlist.id
    }));

    const customOptions: PlaylistSelectionOption[] = customPlaylists.map((playlist) => ({
      value: `CUSTOM:${playlist.id}`,
      label: playlist.name,
      group: 'custom',
      mode: 'CUSTOM',
      playlistId: playlist.id
    }));

    return [...sourceOptions, ...customOptions];
  }, [basePlaylists, customPlaylists]);

  const sourcePlaylistSelectionOptions = useMemo(
    () => playlistSelectionOptions.filter((option) => option.group === 'source'),
    [playlistSelectionOptions]
  );

  const customPlaylistSelectionOptions = useMemo(
    () => playlistSelectionOptions.filter((option) => option.group === 'custom'),
    [playlistSelectionOptions]
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

  const normalizedNewAdminEmail = useMemo(() => newAdminEmail.trim().toLowerCase(), [newAdminEmail]);
  const isNewAdminEmailValid = useMemo(() => isEmailLike(normalizedNewAdminEmail), [normalizedNewAdminEmail]);
  const canRequestNewAdminCode = isNewAdminEmailValid && newAdminPassword.trim().length >= 8;
  const canResendNewAdminCode = isNewAdminEmailValid && newAdminResendCooldownSec <= 0;
  const canConfirmNewAdminCode = /^\d{8}$/.test(newAdminCode.trim());
  const currentAdminEmail = tokenEmail.trim().toLowerCase();
  const hasPendingAdminVerification = pendingAdminEmailForConfirm.trim().length > 0;
  const hasConfirmedAdminInWizard = lastConfirmedAdminEmail.trim().length > 0;
  const canLogin = isEmailLike(email.trim().toLowerCase()) && password.trim().length >= 8;
  const canSubmitRegister =
    isEmailLike(registerEmail.trim().toLowerCase()) &&
    registerPassword.trim().length >= 8 &&
    registerPassword === registerPasswordConfirm;
  const canResendRegister = isEmailLike(registerEmail.trim().toLowerCase()) && registerResendCooldownSec <= 0;
  const canConfirmRegister = /^\d{8}$/.test(registerCode.trim());
  const forgotTargetEmail = (resetEmail || email).trim().toLowerCase();
  const canRequestForgotPassword = isEmailLike(forgotTargetEmail);
  const canSubmitResetPassword =
    resetToken.trim().length > 0 && resetPassword.trim().length >= 8 && resetPassword === resetPasswordConfirm;

  const adminWizardStep = useMemo<1 | 2 | 3>(() => {
    if (hasConfirmedAdminInWizard) {
      return 3;
    }
    if (hasPendingAdminVerification) {
      return 2;
    }
    return 1;
  }, [hasConfirmedAdminInWizard, hasPendingAdminVerification]);

  const filteredAdmins = useMemo(() => {
    const query = adminSearchQuery.trim().toLowerCase();
    const rows = query ? admins.filter((admin) => admin.email.toLowerCase().includes(query)) : admins;

    return [...rows].sort((left, right) => {
      if (adminSortMode === 'email') {
        return left.email.localeCompare(right.email, 'ru', { sensitivity: 'base' });
      }

      const leftMs = parseDateMs(left.createdAt);
      const rightMs = parseDateMs(right.createdAt);
      const byDate = adminSortMode === 'oldest' ? leftMs - rightMs : rightMs - leftMs;
      if (byDate !== 0) {
        return byDate;
      }
      return left.email.localeCompare(right.email, 'ru', { sensitivity: 'base' });
    });
  }, [adminSearchQuery, adminSortMode, admins]);

  const newestAdminCreatedAt = useMemo(() => {
    const newest = sortAdminsByNewest(admins)[0];
    return newest?.createdAt ?? null;
  }, [admins]);

  const parsePlaylistSelectionValue = useCallback(
    (selectionValue: string): { mode: DevicePlaylistMode; playlistId: string } | null => {
      if (selectionValue === SUBSCRIBER_SOURCE_SELECTION_VALUE) {
        return {
          mode: 'SOURCE',
          playlistId: ''
        };
      }

      const match = playlistSelectionOptions.find((option) => option.value === selectionValue);
      if (!match) {
        return null;
      }

      return {
        mode: match.mode,
        playlistId: match.playlistId
      };
    },
    [playlistSelectionOptions]
  );

  const normalizeDeviceModeForSelection = useCallback(
    (mode: DevicePlaylistMode): DevicePlaylistMode => (mode === 'GLOBAL' ? 'SOURCE' : mode),
    []
  );

  const getDefaultSourcePlaylistSelectionValue = useCallback(
    (): string =>
      sourcePlaylistSelectionOptions.length > 0
        ? SUBSCRIBER_SOURCE_SELECTION_VALUE
        : (playlistSelectionOptions.find((option) => option.mode === 'SOURCE')?.value ??
          playlistSelectionOptions[0]?.value ??
          ''),
    [playlistSelectionOptions, sourcePlaylistSelectionOptions]
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
    setFinalClientDrafts((current) => {
      const next: Record<string, FinalClientDraft> = {};
      for (const client of clients) {
        next[client.id] = toFinalClientDraft(client);
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      if (
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => areFinalClientDraftsEqual(current[key], next[key]))
      ) {
        return current;
      }

      return next;
    });

    if (!expandedFinalClientId) {
      return;
    }

    const exists = clients.some((client) => client.id === expandedFinalClientId);
    if (!exists) {
      setExpandedFinalClientId('');
    }
  }, [clients, expandedFinalClientId]);

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
    if (playlistSelectionOptions.length === 0) {
      if (pairPlaylistSelection) {
        setPairPlaylistSelection('');
      }
      if (pairPlaylistMode !== 'SOURCE') {
        setPairPlaylistMode('SOURCE');
      }
      if (pairCustomPlaylistId) {
        setPairCustomPlaylistId('');
      }
      return;
    }

    const hasCurrent = playlistSelectionOptions.some((option) => option.value === pairPlaylistSelection);
    const nextSelection = hasCurrent ? pairPlaylistSelection : playlistSelectionOptions[0].value;

    if (nextSelection !== pairPlaylistSelection) {
      setPairPlaylistSelection(nextSelection);
      return;
    }

    const parsed = parsePlaylistSelectionValue(nextSelection);
    if (!parsed) {
      return;
    }

    if (pairPlaylistMode !== parsed.mode) {
      setPairPlaylistMode(parsed.mode);
    }
    if (pairCustomPlaylistId !== parsed.playlistId) {
      setPairCustomPlaylistId(parsed.playlistId);
    }
  }, [
    pairCustomPlaylistId,
    pairPlaylistMode,
    pairPlaylistSelection,
    parsePlaylistSelectionValue,
    playlistSelectionOptions
  ]);

  useEffect(() => {
    setDevicePlaylistDrafts((current) => {
      const next: Record<string, { mode: DevicePlaylistMode; customPlaylistId: string }> = {};
      for (const device of pairedDevices) {
        const previous = current[device.id];
        const fallbackMode = normalizeDeviceModeForSelection(device.playlistMode);
        const fallbackCustomPlaylistId =
          fallbackMode === 'CUSTOM'
            ? (device.customPlaylistId ?? '')
            : (device.sourcePlaylistId ?? device.customPlaylistId ?? '');
        next[device.id] = previous
          ? {
              mode: normalizeDeviceModeForSelection(previous.mode),
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
            mode: 'SOURCE',
            customPlaylistId: sourcePlaylistSelectionOptions[0]?.playlistId ?? ''
          };
        }

        if (
          next[device.id].mode === 'SOURCE' &&
          draftCustomId &&
          !sourcePlaylistSelectionOptions.some((playlist) => playlist.playlistId === draftCustomId)
        ) {
          next[device.id] = {
            mode: 'SOURCE',
            customPlaylistId: sourcePlaylistSelectionOptions[0]?.playlistId ?? ''
          };
        }
      }
      return next;
    });
  }, [
    customPlaylists,
    normalizeDeviceModeForSelection,
    pairedDevices,
    sourcePlaylistSelectionOptions
  ]);

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
    if (!copiedAdminEmail) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopiedAdminEmail('');
    }, 1500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copiedAdminEmail]);

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
    const message = normalizeErrorMessage(error);
    const unauthorized =
      message.toLowerCase().includes('invalid token') ||
      message.toLowerCase().includes('unauthorized') ||
      message.toLowerCase().includes('не авторизован');

    if (unauthorized) {
      clearStoredToken();
      setTokenRevision((value) => value + 1);
      setStatusTone('error');
      setStatusMessage('Sesiunea a expirat. Autentifica-te din nou.');
      setFocusTopic('account');
      return;
    }

    setStatusTone('error');
    setStatusMessage(message);
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
    }).then((rows) =>
      rows.map((row) => ({
        ...row,
        sourcePlaylistIds: normalizeStringArray(row.sourcePlaylistIds)
      }))
    );
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

  const fetchEpgStatus = useCallback((authToken: string): Promise<EpgStatusItem> => {
    return fetchJson<EpgStatusItem>(`${API_BASE}/epg/status`, {
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

  const fetchAuditLogs = useCallback(
    (
      authToken: string,
      filters: {
        section: AuditSection;
        outcome: 'all' | AuditOutcome;
      }
    ): Promise<AuditLogItem[]> => {
    const params = new URLSearchParams({
      limit: '500',
      scope: 'all',
      section: filters.section,
      outcome: filters.outcome
    });
    return fetchJson<AuditLogItem[]>(`${API_BASE}/audit?${params.toString()}`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    },
    []
  );

  const fetchCustomPlaylistDetail = useCallback(
    (authToken: string, playlistId: string): Promise<CustomPlaylistDetailItem> => {
      return fetchJson<CustomPlaylistDetailItem>(`${API_BASE}/playlist/custom/${playlistId}/channels`, {
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
        setAdmins(sortAdminsByNewest(rows));
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

  const loadEpgStatus = useCallback(
    async (overrideToken?: string, notify = false): Promise<void> => {
      setEpgBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        const status = await fetchEpgStatus(authToken);
        setEpgStatus(status);
        setEpgSourceUrl(/^https?:\/\//i.test(status.sourceUrl ?? '') ? (status.sourceUrl ?? '') : '');

        if (notify) {
          setStatusTone('ok');
          setStatusMessage('EPG status actualizat.');
          setFocusTopic('sources');
        }
      } catch (error) {
        reportError(error);
      } finally {
        setEpgBusy(false);
      }
    },
    [fetchEpgStatus, reportError, requireToken]
  );

  const loadAuditLogs = useCallback(
    async (
      overrideToken?: string,
      overrideFilters?: {
        section?: AuditSection;
        outcome?: 'all' | AuditOutcome;
      }
    ): Promise<void> => {
      setAuditBusy(true);
      try {
        const authToken = requireToken(overrideToken);
        const section = overrideFilters?.section ?? auditSection;
        const filters = {
          section,
          outcome: overrideFilters?.outcome ?? (section === 'internal' ? 'error' : auditOutcome)
        } as const;
        const rows = await fetchAuditLogs(authToken, filters);
        setAuditLogs(rows);
      } catch (error) {
        reportError(error);
      } finally {
        setAuditBusy(false);
      }
    },
    [auditOutcome, auditSection, fetchAuditLogs, reportError, requireToken]
  );

  useEffect(() => {
    if (!token) {
      setLandingPlaylistsPageOpen(false);
      setLandingSubscribersPageOpen(false);
      setAddMenuItem('playlist');
      setPlaylistsSubMenuItem('base');
      setClients([]);
      setAdmins([]);
      setAdminSearchQuery('');
      setAdminSortMode('newest');
      setCopiedAdminEmail('');
      setPendingAdminEmailForConfirm('');
      setLastConfirmedAdminEmail('');
      setNewAdminEmailError('');
      setNewAdminPasswordError('');
      setNewAdminCodeError('');
      setLoginEmailError('');
      setLoginPasswordError('');
      setRegisterEmailError('');
      setRegisterPasswordError('');
      setRegisterPasswordConfirmError('');
      setRegisterCodeError('');
      setForgotEmailError('');
      setResetPasswordError('');
      setResetPasswordConfirmError('');
      setPairedDevices([]);
      setDevicePlaylistDrafts({});
      setPlaylistStatus(null);
      setBasePlaylists([]);
      setPlaylistChannels([]);
      setCustomPlaylists([]);
      setPlaylistSourceName('');
      setPlaylistUrl('');
      setPlaylistFile(null);
      setPlaylistFileInputVersion((value) => value + 1);
      setEpgGzipFile(null);
      setEpgFileInputVersion((value) => value + 1);
      setEpgSourceUrl('');
      setEpgStatus(null);
      clearCustomPlaylistEditor();
      setNewCustomPlaylistName('');
      setPlaylistSourceSearch('');
      setSelectedClientId('');
      setEditingClientId('');
      setPairPlaylistMode('SOURCE');
      setPairCustomPlaylistId('');
      setPairPlaylistSelection('');
      setAuditLogs([]);
      setAuditSection('registration');
      setAuditOutcome('error');
      return;
    }
    void loadClients(token);
    void loadAdmins(token);
    void loadDevices(token);
    void loadPlaylistWorkspace(token);
    void loadEpgStatus(token);
  }, [clearCustomPlaylistEditor, loadAdmins, loadClients, loadDevices, loadEpgStatus, loadPlaylistWorkspace, token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadAuditLogs(token, {
      section: auditSection,
      outcome: auditSection === 'internal' ? 'error' : auditOutcome
    });
  }, [auditOutcome, auditSection, loadAuditLogs, token]);

  useEffect(() => {
    if (!token || !landingPlaylistsPageOpen) {
      return;
    }

    void loadPlaylistWorkspace(token);
  }, [landingPlaylistsPageOpen, loadPlaylistWorkspace, token]);

  useEffect(() => {
    if (token) {
      return;
    }

    const normalizedPairCode = pairCode.trim().toUpperCase();
    if (!normalizedPairCode) {
      return;
    }

    if (!landingAuthOpen) {
      setLandingAuthOpen(true);
    }
    setStatusTone('idle');
    setStatusMessage('Cod Pair detectat. Login admin pentru formularul de abonat nou si pair automat.');
    setFocusTopic('account');
  }, [landingAuthOpen, pairCode, token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const normalizedPairCode = pairCode.trim().toUpperCase();
    if (!normalizedPairCode) {
      return;
    }

    setStudioSection('forms');
    setAddMenuItem('subscriber');
    setStatusTone('idle');
    setStatusMessage('Cod Pair detectat. Completeaza abonatul nou; pair-ul se face automat la creare.');
    setFocusTopic('pairing');
    void Promise.all([loadDevices(token), loadClients(token)]);
  }, [loadClients, loadDevices, pairCode, token]);

  const callAuth = async (): Promise<void> => {
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const emailError = validateEmailRequired(
        normalizedEmail,
        'Введите email администратора.',
        'Введите корректный email администратора.'
      );
      const passwordError = validatePasswordMinLength(password, 'Пароль должен содержать минимум 8 символов.');
      setLoginEmailError(emailError);
      setLoginPasswordError(passwordError);
      if (emailError || passwordError) {
        throw new Error(emailError || passwordError);
      }

      const result = await fetchJson<{ accessToken: string; user?: { email?: string } }>(`${API_BASE}/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail, password })
      });

      storeToken(result.accessToken, rememberMe);
      if (result.user?.email) {
        setEmail(result.user.email);
      } else {
        setEmail(normalizedEmail);
      }
      setLoginEmailError('');
      setLoginPasswordError('');
      setTokenRevision((value) => value + 1);
      await syncClients(result.accessToken, selectedClientId);
      const adminsRows = await fetchAdmins(result.accessToken);
      setAdmins(sortAdminsByNewest(adminsRows));

      setStatusTone('ok');
      setStatusMessage('Вход выполнен. Добро пожаловать!');
      setFocusTopic('session');
      setRegisterModalOpen(false);
      setForgotModalOpen(false);
      setLandingAuthOpen(false);
      setStudioSection('forms');
      setAddMenuItem('playlist');
    } catch (error) {
      reportError(error);
    }
  };

  const requestPasswordReset = async () => {
    try {
      const targetEmail = (resetEmail || email).trim().toLowerCase();
      const emailError = validateEmailRequired(
        targetEmail,
        'Введите email для восстановления пароля.',
        'Введите корректный email для восстановления пароля.'
      );
      setForgotEmailError(emailError);
      if (emailError) {
        throw new Error(emailError);
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/password/forgot`, {
        method: 'POST',
        body: JSON.stringify({ email: targetEmail })
      });

      setResetEmail(targetEmail);
      setForgotEmailError('');
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
    setRegisterEmailError('');
    setRegisterPasswordError('');
    setRegisterPasswordConfirmError('');
    setRegisterCodeError('');
    setRegisterModalOpen(true);
    setLandingAuthOpen(false);
    setForgotModalOpen(false);
    setFocusTopic('account');
  };

  const closeRegisterModal = () => {
    setRegisterModalOpen(false);
    setRegisterCode('');
    setRegisterEmailError('');
    setRegisterPasswordError('');
    setRegisterPasswordConfirmError('');
    setRegisterCodeError('');
    setLandingAuthOpen(true);
  };

  const submitRegistrationForm = async () => {
    try {
      const normalizedEmail = registerEmail.trim().toLowerCase();
      const emailError = validateEmailRequired(normalizedEmail, 'Введите email для регистрации.', 'Введите корректный email для регистрации.');
      const passwordError = validatePasswordMinLength(registerPassword, 'Пароль должен содержать минимум 8 символов.');
      const passwordConfirmError = validatePasswordConfirm(
        registerPassword,
        registerPasswordConfirm,
        'Подтвердите пароль.',
        'Пароль и подтверждение не совпадают.'
      );
      setRegisterEmailError(emailError);
      setRegisterPasswordError(passwordError);
      setRegisterPasswordConfirmError(passwordConfirmError);
      if (emailError || passwordError || passwordConfirmError) {
        throw new Error(emailError || passwordError || passwordConfirmError);
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register`, {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
          password: registerPassword
        })
      });

      setEmail(normalizedEmail);
      setRegisterEmail(normalizedEmail);
      setRegisterPassword('');
      setRegisterPasswordConfirm('');
      setRegisterPasswordError('');
      setRegisterPasswordConfirmError('');
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
      const codeError = validateCode8Digits(normalizedCode, 'Введите код подтверждения.', 'Введите 8-значный код из письма.');
      setRegisterCodeError(codeError);
      if (codeError) {
        throw new Error(codeError);
      }

      const result = await fetchJson<{ accessToken: string; user?: { email?: string } }>(`${API_BASE}/auth/register/confirm`, {
        method: 'POST',
        body: JSON.stringify({ token: normalizedCode })
      });

      storeToken(result.accessToken, rememberMe);
      setTokenRevision((value) => value + 1);
      await syncClients(result.accessToken, selectedClientId);
      const adminsRows = await fetchAdmins(result.accessToken);
      setAdmins(sortAdminsByNewest(adminsRows));

      if (result.user?.email) {
        setEmail(result.user.email);
      } else if (registerEmail.trim()) {
        setEmail(registerEmail.trim().toLowerCase());
      }

      setRegisterCode('');
      setRegisterPassword('');
      setRegisterPasswordConfirm('');
      setRegisterEmailError('');
      setRegisterPasswordError('');
      setRegisterPasswordConfirmError('');
      setRegisterCodeError('');
      setRegisterModalOpen(false);
      setLandingAuthOpen(false);
      setStudioSection('forms');
      setAddMenuItem('playlist');
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
      const emailError = validateEmailRequired(
        normalizedEmail,
        'Введите email для повторной отправки подтверждения.',
        'Введите корректный email для повторной отправки подтверждения.'
      );
      setRegisterEmailError(emailError);
      if (emailError) {
        throw new Error(emailError);
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register/resend`, {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail })
      });

      setRegisterEmailError('');
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
    setForgotEmailError('');
    setRegisterModalOpen(false);
    setForgotModalOpen(true);
    setLandingAuthOpen(false);
    setFocusTopic('account');
  };

  const closeForgotPasswordModal = () => {
    setForgotModalOpen(false);
    setForgotEmailError('');
    setLandingAuthOpen(true);
  };

  const closeResetModal = () => {
    setResetModalOpen(false);
    setRegisterModalOpen(false);
    setForgotModalOpen(false);
    setResetToken('');
    setResetPassword('');
    setResetPasswordConfirm('');
    setResetPasswordError('');
    setResetPasswordConfirmError('');
    removeQueryParam('resetToken');
    setLandingAuthOpen(true);
  };

  const submitPasswordReset = async () => {
    try {
      const normalizedToken = resetToken.trim();
      if (!normalizedToken) {
        throw new Error('Токен восстановления отсутствует.');
      }

      const passwordError = validatePasswordMinLength(resetPassword, 'Новый пароль должен содержать минимум 8 символов.');
      const passwordConfirmError = validatePasswordConfirm(
        resetPassword,
        resetPasswordConfirm,
        'Повторите новый пароль.',
        'Пароли не совпадают.'
      );
      setResetPasswordError(passwordError);
      setResetPasswordConfirmError(passwordConfirmError);
      if (passwordError || passwordConfirmError) {
        throw new Error(passwordError || passwordConfirmError);
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
      setResetPasswordError('');
      setResetPasswordConfirmError('');
      removeQueryParam('resetToken');
      setLandingAuthOpen(true);
    } catch (error) {
      reportError(error);
    }
  };

  const logout = () => {
    clearStoredToken();
    setTokenRevision((value) => value + 1);
    setLandingPlaylistsPageOpen(false);
    setLandingSubscribersPageOpen(false);
    setLandingAuthOpen(false);
    setRegisterModalOpen(false);
    setForgotModalOpen(false);
    setClients([]);
    setAdmins([]);
    setAdminSearchQuery('');
    setAdminSortMode('newest');
    setCopiedAdminEmail('');
    setPendingAdminEmailForConfirm('');
    setLastConfirmedAdminEmail('');
    setNewAdminEmailError('');
    setNewAdminPasswordError('');
    setNewAdminCodeError('');
    setLoginEmailError('');
    setLoginPasswordError('');
    setRegisterEmailError('');
    setRegisterPasswordError('');
    setRegisterPasswordConfirmError('');
    setRegisterCodeError('');
    setForgotEmailError('');
    setResetPasswordError('');
    setResetPasswordConfirmError('');
    setSelectedClientId('');
    setEditingClientId('');
    setStatusTone('ok');
    setStatusMessage('Локальный токен удален.');
    setFocusTopic('session');
  };

  const handleNewAdminEmailChange = (value: string): void => {
    setNewAdminEmail(value);
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      setNewAdminEmailError('');
      return;
    }
    setNewAdminEmailError(isEmailLike(normalized) ? '' : 'Введите корректный email нового администратора.');
  };

  const handleNewAdminPasswordChange = (value: string): void => {
    setNewAdminPassword(value);
    if (!value.trim()) {
      setNewAdminPasswordError('');
      return;
    }
    setNewAdminPasswordError(value.trim().length >= 8 ? '' : 'Минимум 8 символов.');
  };

  const handleNewAdminCodeChange = (value: string): void => {
    const normalized = value.replace(/\D/g, '').slice(0, 8);
    setNewAdminCode(normalized);
    if (!normalized) {
      setNewAdminCodeError('');
      return;
    }
    setNewAdminCodeError(/^\d{8}$/.test(normalized) ? '' : 'Код должен состоять из 8 цифр.');
  };

  const handleLoginEmailChange = (value: string): void => {
    setEmail(value);
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      setLoginEmailError('');
      return;
    }
    setLoginEmailError(isEmailLike(normalized) ? '' : 'Введите корректный email администратора.');
  };

  const handleLoginPasswordChange = (value: string): void => {
    setPassword(value);
    if (!value.trim()) {
      setLoginPasswordError('');
      return;
    }
    setLoginPasswordError(value.trim().length >= 8 ? '' : 'Минимум 8 символов.');
  };

  const handleRegisterEmailChange = (value: string): void => {
    setRegisterEmail(value);
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      setRegisterEmailError('');
      return;
    }
    setRegisterEmailError(isEmailLike(normalized) ? '' : 'Введите корректный email для регистрации.');
  };

  const handleRegisterPasswordChange = (value: string): void => {
    setRegisterPassword(value);
    if (!value.trim()) {
      setRegisterPasswordError('');
    } else {
      setRegisterPasswordError(value.trim().length >= 8 ? '' : 'Минимум 8 символов.');
    }

    if (!registerPasswordConfirm) {
      setRegisterPasswordConfirmError('');
      return;
    }
    setRegisterPasswordConfirmError(value === registerPasswordConfirm ? '' : 'Пароль и подтверждение не совпадают.');
  };

  const handleRegisterPasswordConfirmChange = (value: string): void => {
    setRegisterPasswordConfirm(value);
    if (!value) {
      setRegisterPasswordConfirmError('');
      return;
    }
    setRegisterPasswordConfirmError(registerPassword === value ? '' : 'Пароль и подтверждение не совпадают.');
  };

  const handleRegisterCodeChange = (value: string): void => {
    const normalized = value.replace(/\D/g, '').slice(0, 8);
    setRegisterCode(normalized);
    if (!normalized) {
      setRegisterCodeError('');
      return;
    }
    setRegisterCodeError(/^\d{8}$/.test(normalized) ? '' : 'Код должен состоять из 8 цифр.');
  };

  const handleForgotEmailChange = (value: string): void => {
    setResetEmail(value);
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      setForgotEmailError('');
      return;
    }
    setForgotEmailError(isEmailLike(normalized) ? '' : 'Введите корректный email для восстановления пароля.');
  };

  const handleResetPasswordChange = (value: string): void => {
    setResetPassword(value);
    if (!value.trim()) {
      setResetPasswordError('');
    } else {
      setResetPasswordError(value.trim().length >= 8 ? '' : 'Минимум 8 символов.');
    }

    if (!resetPasswordConfirm) {
      setResetPasswordConfirmError('');
      return;
    }
    setResetPasswordConfirmError(value === resetPasswordConfirm ? '' : 'Пароли не совпадают.');
  };

  const handleResetPasswordConfirmChange = (value: string): void => {
    setResetPasswordConfirm(value);
    if (!value) {
      setResetPasswordConfirmError('');
      return;
    }
    setResetPasswordConfirmError(resetPassword === value ? '' : 'Пароли не совпадают.');
  };

  const requestNewAdminCode = async () => {
    try {
      const normalizedEmail = newAdminEmail.trim().toLowerCase();
      const emailError = validateAdminEmailRequired(normalizedEmail);
      const passwordError = validateAdminPasswordRequired(newAdminPassword);
      setNewAdminEmailError(emailError);
      setNewAdminPasswordError(passwordError);
      if (emailError || passwordError) {
        throw new Error(emailError || passwordError);
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register`, {
        method: 'POST',
        body: JSON.stringify({
          email: normalizedEmail,
          password: newAdminPassword.trim()
        })
      });

      setNewAdminEmail(normalizedEmail);
      setNewAdminEmailError('');
      setNewAdminPasswordError('');
      setPendingAdminEmailForConfirm(normalizedEmail);
      setLastConfirmedAdminEmail('');
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
      const emailError = validateAdminEmailRequired(normalizedEmail);
      setNewAdminEmailError(emailError);
      if (emailError) {
        throw new Error(emailError);
      }

      const result = await fetchJson<{ success: true; message: string }>(`${API_BASE}/auth/register/resend`, {
        method: 'POST',
        body: JSON.stringify({ email: normalizedEmail })
      });

      setNewAdminEmailError('');
      setPendingAdminEmailForConfirm(normalizedEmail);
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
      const codeError = validateAdminCodeRequired(normalizedCode);
      setNewAdminCodeError(codeError);
      if (codeError) {
        throw new Error(codeError);
      }

      await fetchJson<{ accessToken: string }>(`${API_BASE}/auth/register/confirm`, {
        method: 'POST',
        body: JSON.stringify({ token: normalizedCode })
      });

      const confirmedEmail = pendingAdminEmailForConfirm || newAdminEmail.trim().toLowerCase();
      await loadAdmins(authToken);
      setNewAdminEmail('');
      setNewAdminPassword('');
      setNewAdminCode('');
      setNewAdminEmailError('');
      setNewAdminPasswordError('');
      setNewAdminCodeError('');
      setNewAdminResendCooldownSec(0);
      setPendingAdminEmailForConfirm('');
      setLastConfirmedAdminEmail(confirmedEmail);
      setStatusTone('ok');
      setStatusMessage('Новый администратор подтвержден и добавлен.');
      setFocusTopic('admins');
    } catch (error) {
      reportError(error);
    }
  };

  const copyAdminEmail = async (adminEmail: string): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Буфер обмена недоступен в этом браузере.');
      }

      await navigator.clipboard.writeText(adminEmail);
      setCopiedAdminEmail(adminEmail);
      setStatusTone('ok');
      setStatusMessage(`Email скопирован: ${adminEmail}.`);
      setFocusTopic('admins');
    } catch (error) {
      reportError(error);
    }
  };

  const deleteAdmin = async (admin: AdminItem) => {
    if (currentAdminEmail && admin.email.toLowerCase() === currentAdminEmail) {
      setStatusTone('error');
      setStatusMessage('Нельзя удалить администратора, под которым выполнен текущий вход.');
      setFocusTopic('admins');
      return;
    }

    if (admins.length <= 1) {
      setStatusTone('error');
      setStatusMessage('Нельзя удалить последнего администратора.');
      setFocusTopic('admins');
      return;
    }

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
          devicesAllowed,
          sourcePlaylistIds: clientSourcePlaylistIds
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
      setClientSourcePlaylistIds([]);

      const normalizedPairCode = pairCode.trim().toUpperCase();
      if (normalizedPairCode) {
        try {
          await confirmPair(created.id, `Abonat adaugat si TV conectat: ${created.lastName} ${created.firstName}.`);
        } catch (pairError) {
          setStatusTone('error');
          setStatusMessage(
            `Abonatul a fost adaugat (${created.lastName} ${created.firstName}), dar pairing-ul a esuat: ${normalizeErrorMessage(pairError)}.`
          );
          setFocusTopic('pairing');
        }
        return;
      }

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

  const toggleFinalClientCard = (client: ClientItem): void => {
    setExpandedFinalClientId((current) => (current === client.id ? '' : client.id));
    setFinalClientDrafts((current) => {
      if (current[client.id]) {
        return current;
      }

      return {
        ...current,
        [client.id]: toFinalClientDraft(client)
      };
    });
  };

  const setFinalClientDraftField = (clientId: string, field: FinalClientTextField, value: string): void => {
    setFinalClientDrafts((current) => {
      const draft = current[clientId];
      if (!draft) {
        return current;
      }

      return {
        ...current,
        [clientId]: {
          ...draft,
          [field]: value
        }
      };
    });
  };

  const setFinalClientDraftSourcePlaylists = (clientId: string, sourcePlaylistIds: string[]): void => {
    setFinalClientDrafts((current) => {
      const draft = current[clientId];
      if (!draft) {
        return current;
      }

      return {
        ...current,
        [clientId]: {
          ...draft,
          sourcePlaylistIds
        }
      };
    });
  };

  const resetFinalClientDraft = (client: ClientItem): void => {
    setFinalClientDrafts((current) => ({
      ...current,
      [client.id]: toFinalClientDraft(client)
    }));
  };

  const saveFinalClient = async (client: ClientItem): Promise<void> => {
    try {
      const draft = finalClientDrafts[client.id] ?? toFinalClientDraft(client);
      const devicesAllowed = Number.parseInt(draft.devicesAllowed.trim(), 10);
      if (!Number.isFinite(devicesAllowed) || devicesAllowed < 1) {
        throw new Error('Cantitatea de device-uri trebuie sa fie cel putin 1.');
      }

      const nextPayload = {
        firstName: draft.firstName,
        lastName: draft.lastName,
        phone: draft.phone,
        address: draft.address,
        devicesAllowed,
        sourcePlaylistIds: draft.sourcePlaylistIds
      };
      const hasChanges =
        nextPayload.firstName !== client.firstName ||
        nextPayload.lastName !== client.lastName ||
        nextPayload.phone !== client.phone ||
        nextPayload.address !== client.address ||
        nextPayload.devicesAllowed !== client.devicesAllowed ||
        !areStringArraysEqual(nextPayload.sourcePlaylistIds, client.sourcePlaylistIds);

      if (!hasChanges) {
        setStatusTone('ok');
        setStatusMessage(`Nu exista modificari pentru ${client.lastName} ${client.firstName}.`);
        return;
      }

      setClientBusy(true);
      const authToken = requireToken();
      const updated = await fetchJson<ClientItem>(`${API_BASE}/clients/${client.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(nextPayload)
      });

      await syncClients(authToken, updated.id);
      setStatusTone('ok');
      setStatusMessage(`Abonat actualizat: ${updated.lastName} ${updated.firstName}.`);
      setFocusTopic('clients');
    } catch (error) {
      reportError(error);
    } finally {
      setClientBusy(false);
    }
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

  const confirmPair = async (overrideClientId?: string, successMessage?: string) => {
    try {
      const normalizedCode = pairCode.trim().toUpperCase();
      if (!normalizedCode) {
        throw new Error('Introdu codul de Pair de pe TV.');
      }
      if (!/^[A-Z0-9]{6,8}$/.test(normalizedCode)) {
        throw new Error('Codul Pair trebuie sa aiba 6-8 caractere (litere/cifre).');
      }

      const authToken = requireToken();
      const normalizedClientId = (overrideClientId ?? selectedClientId).trim();
      if (!normalizedClientId) {
        throw new Error('Creeaza sau selecteaza abonatul pentru acest Pair.');
      }
      const parsedPairPlaylistSelection = parsePlaylistSelectionValue(pairPlaylistSelection);
      if (!parsedPairPlaylistSelection) {
        throw new Error('Selecteaza un playlist existent.');
      }
      await fetchJson<{ success: true }>(`${API_BASE}/devices/pair/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          code: normalizedCode,
          clientId: normalizedClientId,
          playlistMode: parsedPairPlaylistSelection.mode,
          customPlaylistId: parsedPairPlaylistSelection.playlistId || undefined
        })
      });

      await loadDevices(authToken);
      setPairCode('');
      removeQueryParam('pairCode');
      setStatusTone('ok');
      setStatusMessage(successMessage ?? 'Device confirmat. Il gasesti in meniul Abonati Finali.');
      setFocusTopic('pairing');
    } catch (error) {
      if (overrideClientId) {
        throw error;
      }
      reportError(error);
    }
  };

  const setPairPlaylistSelectionValue = (selectionValue: string): void => {
    setPairPlaylistSelection(selectionValue);
    const parsed = parsePlaylistSelectionValue(selectionValue);
    if (!parsed) {
      return;
    }
    setPairPlaylistMode(parsed.mode);
    setPairCustomPlaylistId(parsed.playlistId);
  };

  const getDevicePlaylistDraft = (
    device: PairedDeviceItem
  ): { mode: DevicePlaylistMode; customPlaylistId: string } => {
    const normalizedMode = normalizeDeviceModeForSelection(device.playlistMode);
    const fallbackPlaylistId =
      normalizedMode === 'CUSTOM'
        ? (device.customPlaylistId ?? '')
        : (device.sourcePlaylistId ?? device.customPlaylistId ?? '');

    return (
      devicePlaylistDrafts[device.id] ?? {
        mode: normalizedMode,
        customPlaylistId: fallbackPlaylistId
      }
    );
  };

  const setDevicePlaylistModeDraft = (deviceId: string, mode: DevicePlaylistMode): void => {
    setDevicePlaylistDrafts((current) => ({
      ...current,
      [deviceId]: {
        mode,
        customPlaylistId: mode === 'GLOBAL' ? '' : (current[deviceId]?.customPlaylistId ?? '')
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

  const getDevicePlaylistSelectionValue = (device: PairedDeviceItem): string => {
    const draft = getDevicePlaylistDraft(device);
    if (draft.mode === 'CUSTOM') {
      return `CUSTOM:${draft.customPlaylistId}`;
    }

    if (draft.customPlaylistId) {
      const sourceValue = `SOURCE:${draft.customPlaylistId}`;
      if (playlistSelectionOptions.some((option) => option.value === sourceValue)) {
        return sourceValue;
      }
    }

    return getDefaultSourcePlaylistSelectionValue();
  };

  const getDeviceCurrentPlaylistLabel = (device: PairedDeviceItem): string => {
    if (device.playlistMode === 'CUSTOM') {
      if (device.customPlaylistName) {
        return device.customPlaylistName;
      }
      const customOption = playlistSelectionOptions.find(
        (option) => option.mode === 'CUSTOM' && option.playlistId === (device.customPlaylistId ?? '')
      );
      return customOption?.label ?? 'Playlist custom';
    }

    if (device.sourcePlaylistName) {
      return device.sourcePlaylistName;
    }

    const sourceId = device.sourcePlaylistId ?? device.customPlaylistId ?? '';
    const sourceOption = sourceId
      ? playlistSelectionOptions.find((option) => option.mode === 'SOURCE' && option.playlistId === sourceId)
      : playlistSelectionOptions.find((option) => option.mode === 'SOURCE');

    if (sourceOption) {
      return sourceOption.label;
    }

    return playlistSelectionOptions[0]?.label ?? 'Fara playlist';
  };

  const setDevicePlaylistSelectionValue = (deviceId: string, selectionValue: string): void => {
    const parsed = parsePlaylistSelectionValue(selectionValue);
    if (!parsed) {
      return;
    }

    setDevicePlaylistModeDraft(deviceId, parsed.mode);
    setDeviceCustomPlaylistDraft(deviceId, parsed.playlistId);
  };

  const saveDevicePlaylistAssignment = async (device: PairedDeviceItem): Promise<void> => {
    const draft = getDevicePlaylistDraft(device);
    if (draft.mode === 'CUSTOM' && !draft.customPlaylistId) {
      setStatusTone('error');
      setStatusMessage('Selecteaza un playlist din lista.');
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
          customPlaylistId: draft.customPlaylistId || undefined
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
      if (!normalizedName) {
        throw new Error('Введите название базового плейлиста.');
      }

      const authToken = requireToken();
      setPlaylistBusy(true);
      if (playlistFile) {
        if (playlistFile.size > PLAYLIST_FILE_MAX_BYTES) {
          throw new Error('Файл плейлиста слишком большой. Максимум 2 MB.');
        }

        const content = (await playlistFile.text()).replace(/^\uFEFF/, '').trim();
        if (!content) {
          throw new Error('Выбранный файл плейлиста пустой.');
        }

        await fetchJson<BasePlaylistItem>(`${API_BASE}/playlist/sources/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({
            name: normalizedName,
            fileName: playlistFile.name || 'uploaded-playlist.m3u8',
            content
          })
        });
      } else {
        const normalizedUrl = playlistUrl.trim();
        if (!normalizedUrl) {
          throw new Error('Введите URL плейлиста или выберите файл.');
        }
        if (countHttpSchemes(normalizedUrl) > 1) {
          throw new Error('URL содержит больше одной ссылки. Вставьте только один полный URL.');
        }

        await fetchJson<BasePlaylistItem>(`${API_BASE}/playlist/sources`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ name: normalizedName, url: normalizedUrl })
        });
      }

      await loadPlaylistWorkspace(authToken);
      setPlaylistSourceName('');
      setPlaylistUrl('');
      setPlaylistFile(null);
      setPlaylistFileInputVersion((value) => value + 1);

      setStatusTone('ok');
      setStatusMessage(
        playlistFile
          ? `Базовый плейлист добавлен из файла: ${normalizedName}.`
          : `Базовый плейлист добавлен: ${normalizedName}.`
      );
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setPlaylistBusy(false);
    }
  };

  const uploadEpgGzipFile = async () => {
    try {
      if (!epgGzipFile) {
        throw new Error('Selecteaza fisierul EPG .gz.');
      }
      if (epgGzipFile.size > EPG_GZIP_FILE_MAX_BYTES) {
        throw new Error('Fisierul EPG este prea mare. Maxim 80 MB.');
      }
      if (!epgGzipFile.name.toLowerCase().endsWith('.gz')) {
        throw new Error('Fisierul EPG trebuie sa fie .gz.');
      }

      const authToken = requireToken();
      setEpgBusy(true);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);

      let result: EpgUploadResult | null = null;
      try {
        const formData = new FormData();
        formData.set('file', epgGzipFile, epgGzipFile.name || 'epg-upload.xml.gz');

        const response = await fetch(`${API_BASE}/epg/upload-gz`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`
          },
          body: formData,
          signal: controller.signal
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }

        result = (await response.json()) as EpgUploadResult;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('Timeout la upload EPG. Incearca din nou.');
        }

        if (error instanceof TypeError) {
          throw new Error(`Nu s-a putut conecta la API: ${API_BASE}/epg/upload-gz`);
        }

        throw error;
      } finally {
        clearTimeout(timeout);
      }

      await loadEpgStatus(authToken);
      setEpgGzipFile(null);
      setEpgFileInputVersion((value) => value + 1);

      setStatusTone('ok');
      setStatusMessage(
        result
          ? `EPG incarcat: ${result.snapshotChannels} canale (${result.fileName}).`
          : 'EPG incarcat din fisier.'
      );
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setEpgBusy(false);
    }
  };

  const saveEpgSourceUrl = async () => {
    try {
      const normalizedUrl = epgSourceUrl.trim();
      if (!normalizedUrl) {
        throw new Error('Introdu cel putin un URL EPG.');
      }

      const authToken = requireToken();
      setEpgBusy(true);
      await fetchJson<{ success: true }>(`${API_BASE}/epg/set-url`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ url: normalizedUrl })
      });

      await loadEpgStatus(authToken);
      setStatusTone('ok');
      setStatusMessage('URL-ul EPG a fost salvat.');
      setFocusTopic('sources');
    } catch (error) {
      reportError(error);
    } finally {
      setEpgBusy(false);
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

  const openLandingAuth = () => {
    if (token) {
      setStudioSection('forms');
      setAddMenuItem('playlist');
      setLandingAuthOpen(false);
      setRegisterModalOpen(false);
      setForgotModalOpen(false);
      return;
    }

    setLoginEmailError('');
    setLoginPasswordError('');
    setLandingAuthOpen(true);
    setRegisterModalOpen(false);
    setForgotModalOpen(false);
    setFocusTopic('account');
  };

  const closeLandingAuthModal = () => {
    setLoginEmailError('');
    setLoginPasswordError('');
    setLandingAuthOpen(false);
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
      void loadEpgStatus(token);
    }
  };

  const continueWizardToPlaylists = (): void => {
    setStudioSection('forms');
    setAddMenuItem('playlist');
    setFocusTopic('sources');
    if (token) {
      void Promise.all([loadPlaylistWorkspace(token), loadClients(token, selectedClientId)]);
    }
  };

  const openAddMenuItem = (item: AddMenuItem): void => {
    setAddMenuItem(item);

    if (!token) {
      return;
    }

    if (item === 'playlist') {
      setFocusTopic('sources');
      void loadPlaylistWorkspace(token);
      return;
    }

    setFocusTopic('clients');
    void loadClients(token, selectedClientId);
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

  if (!token) {
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
                Account
              </button>
              <button
                type="button"
                className={landingActiveTile === 'how' ? 'wa-base-top-nav-item is-active' : 'wa-base-top-nav-item'}
                onClick={() => openLandingTile('how')}
              >
                Как это работает
              </button>
            </nav>

            <button type="button" className="wa-base-top-login" onClick={openLandingAuth}>
              Autentificare Admin
            </button>
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
              Account
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
                  openSubscribersPage();
                } else {
                  openLandingAuth();
                }
                setLandingMenuOpen(false);
              }}
            >
              {token ? 'Account' : 'Вход администратора'}
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

                  <label className="wa-row">
                    <span className="wa-label">или файл плейлиста (M3U / M3U8)</span>
                    <input
                      key={`landing-playlist-file-${playlistFileInputVersion}`}
                      className="wa-input"
                      type="file"
                      accept=".m3u,.m3u8,text/plain,application/x-mpegURL,audio/x-mpegurl"
                      onChange={(event) => setPlaylistFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  <p className="wa-base-playlists-meta">Если выбран файл, поле URL не используется.</p>
                  {playlistFile ? <p className="wa-base-playlists-meta">Выбран файл: {playlistFile.name}</p> : null}

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
                            <p className="wa-base-playlists-custom-item-meta">
                              {playlist.sourceType === 'file'
                                ? `Файл: ${playlist.fileName ?? 'uploaded-playlist.m3u8'}`
                                : playlist.url}
                            </p>
                            <p className="wa-base-playlists-custom-item-meta">
                              каналов: {playlist.channelsCount} | обновлено: {formatDateTime(playlist.cacheUpdatedAt)}
                            </p>
                            <div className="wa-actions">
                              <button
                                type="button"
                                className="wa-btn"
                                onClick={() => void refreshBasePlaylist(playlist.id, playlist.name)}
                                disabled={playlistBusy || playlist.sourceType === 'file'}
                                title={
                                  playlist.sourceType === 'file'
                                    ? 'Источник добавлен из файла. Для обновления загрузите новый файл.'
                                    : undefined
                                }
                              >
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
                Раздел аккаунтов встроен в основную страницу. Управление происходит прямо здесь, без отдельного экрана.
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
                  <span className="wa-base-tile-label">account</span>
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
                    Scanează QR-ul de pe TV și deschide linkul. Aici confirmi pair-ul pentru abonatul ales.
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

                        <p className="wa-base-playlists-meta">
                          QR Pair: {pairCode.trim() ? pairCode.trim().toUpperCase() : 'nu este detectat (deschide linkul QR din nou)'}
                        </p>

                        <label className="wa-row">
                          <span className="wa-label">Плейлист для нового устройства</span>
                          <select
                            className="wa-input"
                            value={pairPlaylistSelection}
                            onChange={(event) => setPairPlaylistSelectionValue(event.target.value)}
                          >
                            {playlistSelectionOptions.length === 0 ? (
                              <option value="">Nu exista playlisturi</option>
                            ) : (
                              <>
                                {sourcePlaylistSelectionOptions.length > 0 ? (
                                  <>
                                    <option value={SUBSCRIBER_SOURCE_SELECTION_VALUE}>Playlisturile abonatului (multiple)</option>
                                    <optgroup label="Surse de baza">
                                      {sourcePlaylistSelectionOptions.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </optgroup>
                                  </>
                                ) : null}
                                {customPlaylistSelectionOptions.length > 0 ? (
                                  <optgroup label="Constructor custom">
                                    {customPlaylistSelectionOptions.map((option) => (
                                      <option key={option.value} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ) : null}
                              </>
                            )}
                          </select>
                        </label>

                        <div className="wa-row wa-row--actions">
                          <span className="wa-label">Действия</span>
                          <div className="wa-actions">
                            <button type="button" className="wa-btn wa-btn--primary" onClick={() => void confirmPair()} disabled={!pairCode.trim()}>
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
                                draft.mode !== normalizeDeviceModeForSelection(device.playlistMode) ||
                                (draft.mode === 'CUSTOM'
                                  ? draft.customPlaylistId !== (device.customPlaylistId ?? '')
                                  : draft.customPlaylistId !== (device.sourcePlaylistId ?? device.customPlaylistId ?? ''));

                              return (
                                <article key={device.id} className="wa-base-devices-item">
                                  <p className="wa-base-devices-item-name">{device.name}</p>
                                  <p className="wa-base-devices-item-meta">
                                    {formatDeviceIdentity(device)}
                                  </p>
                                  <p className="wa-base-devices-item-meta">
                                    Client: {device.clientName || 'без абонента'}
                                  </p>
                                  <p className="wa-base-devices-item-meta">
                                    Pair: {formatDateTime(device.pairedAt)} | Online: {formatDateTime(device.lastSeenAt)}
                                  </p>
                                  <p className="wa-base-devices-item-meta">
                                    Playlist actual: {getDeviceCurrentPlaylistLabel(device)}
                                  </p>

                                  <label className="wa-row">
                                    <span className="wa-label">Playlist dorit</span>
                                    <select
                                      className="wa-input"
                                      value={getDevicePlaylistSelectionValue(device)}
                                      onChange={(event) => setDevicePlaylistSelectionValue(device.id, event.target.value)}
                                    >
                                      {playlistSelectionOptions.length === 0 ? (
                                        <option value="">Nu exista playlisturi</option>
                                      ) : (
                                        <>
                                          {sourcePlaylistSelectionOptions.length > 0 ? (
                                            <>
                                              <option value={SUBSCRIBER_SOURCE_SELECTION_VALUE}>Playlisturile abonatului (multiple)</option>
                                              <optgroup label="Surse de baza">
                                                {sourcePlaylistSelectionOptions.map((option) => (
                                                  <option key={option.value} value={option.value}>
                                                    {option.label}
                                                  </option>
                                                ))}
                                              </optgroup>
                                            </>
                                          ) : null}
                                          {customPlaylistSelectionOptions.length > 0 ? (
                                            <optgroup label="Constructor custom">
                                              {customPlaylistSelectionOptions.map((option) => (
                                                <option key={option.value} value={option.value}>
                                                  {option.label}
                                                </option>
                                              ))}
                                            </optgroup>
                                          ) : null}
                                        </>
                                      )}
                                    </select>
                                  </label>

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
                      откройте нужный раздел через кнопки Playlists, Devices или Account.
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
          <div className="wa-base-auth-overlay" role="presentation" onClick={closeLandingAuthModal}>
            <div className="wa-base-auth-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
              <p className="wa-base-auth-title">Вход администратора</p>
              <p className="wa-base-auth-subtitle">
                Введите данные администратора для входа в панель.
              </p>

              <label className="wa-base-auth-label">
                <span>Эл. почта</span>
                <input
                  className={loginEmailError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  value={email}
                  onChange={(event) => handleLoginEmailChange(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="username"
                  aria-invalid={Boolean(loginEmailError)}
                  aria-describedby={loginEmailError ? 'wa-login-email-error' : undefined}
                />
                {loginEmailError ? (
                  <p id="wa-login-email-error" className="wa-base-auth-field-error">
                    {loginEmailError}
                  </p>
                ) : null}
              </label>

              <label className="wa-base-auth-label">
                <span>Пароль</span>
                <input
                  className={loginPasswordError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  type="password"
                  value={password}
                  onChange={(event) => handleLoginPasswordChange(event.target.value)}
                  placeholder="********"
                  autoComplete="current-password"
                  aria-invalid={Boolean(loginPasswordError)}
                  aria-describedby={loginPasswordError ? 'wa-login-password-error' : undefined}
                />
                {loginPasswordError ? (
                  <p id="wa-login-password-error" className="wa-base-auth-field-error">
                    {loginPasswordError}
                  </p>
                ) : null}
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
                  disabled={!canLogin}
                >
                  Войти
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--ghost"
                  onClick={closeLandingAuthModal}
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
                  className={registerEmailError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  value={registerEmail}
                  onChange={(event) => handleRegisterEmailChange(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="email"
                  aria-invalid={Boolean(registerEmailError)}
                  aria-describedby={registerEmailError ? 'wa-register-email-error' : undefined}
                />
                {registerEmailError ? (
                  <p id="wa-register-email-error" className="wa-base-auth-field-error">
                    {registerEmailError}
                  </p>
                ) : null}
              </label>

              <label className="wa-base-auth-label">
                <span>Пароль</span>
                <input
                  className={registerPasswordError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  type="password"
                  value={registerPassword}
                  onChange={(event) => handleRegisterPasswordChange(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                  aria-invalid={Boolean(registerPasswordError)}
                  aria-describedby={registerPasswordError ? 'wa-register-password-error' : undefined}
                />
                {registerPasswordError ? (
                  <p id="wa-register-password-error" className="wa-base-auth-field-error">
                    {registerPasswordError}
                  </p>
                ) : null}
              </label>

              <label className="wa-base-auth-label">
                <span>Подтверждение пароля</span>
                <input
                  className={registerPasswordConfirmError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  type="password"
                  value={registerPasswordConfirm}
                  onChange={(event) => handleRegisterPasswordConfirmChange(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                  aria-invalid={Boolean(registerPasswordConfirmError)}
                  aria-describedby={registerPasswordConfirmError ? 'wa-register-password-confirm-error' : undefined}
                />
                {registerPasswordConfirmError ? (
                  <p id="wa-register-password-confirm-error" className="wa-base-auth-field-error">
                    {registerPasswordConfirmError}
                  </p>
                ) : null}
              </label>

              <label className="wa-base-auth-label">
                <span>Код подтверждения</span>
                <input
                  className={registerCodeError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  value={registerCode}
                  onChange={(event) => handleRegisterCodeChange(event.target.value)}
                  placeholder="12345678"
                  inputMode="numeric"
                  maxLength={8}
                  aria-invalid={Boolean(registerCodeError)}
                  aria-describedby={registerCodeError ? 'wa-register-code-error' : undefined}
                />
                {registerCodeError ? (
                  <p id="wa-register-code-error" className="wa-base-auth-field-error">
                    {registerCodeError}
                  </p>
                ) : null}
              </label>

              <div className="wa-base-auth-actions">
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void submitRegistrationForm()}
                  disabled={!canSubmitRegister}
                >
                  Зарегистрироваться
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn"
                  onClick={() => void resendRegistrationForm()}
                  disabled={!canResendRegister}
                >
                  {registerResendCooldownSec > 0
                    ? `Повторно отправить (${formatCountdown(registerResendCooldownSec)})`
                    : 'Повторно отправить письмо'}
                </button>
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void confirmRegistrationForm()}
                  disabled={!canConfirmRegister}
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
                  className={forgotEmailError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  value={resetEmail}
                  onChange={(event) => handleForgotEmailChange(event.target.value)}
                  placeholder="admin@example.com"
                  autoComplete="email"
                  aria-invalid={Boolean(forgotEmailError)}
                  aria-describedby={forgotEmailError ? 'wa-forgot-email-error' : undefined}
                />
                {forgotEmailError ? (
                  <p id="wa-forgot-email-error" className="wa-base-auth-field-error">
                    {forgotEmailError}
                  </p>
                ) : null}
              </label>

              <div className="wa-base-auth-actions">
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void requestPasswordReset()}
                  disabled={!canRequestForgotPassword}
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
                  className={resetPasswordError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  type="password"
                  value={resetPassword}
                  onChange={(event) => handleResetPasswordChange(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                  aria-invalid={Boolean(resetPasswordError)}
                  aria-describedby={resetPasswordError ? 'wa-reset-password-error' : undefined}
                />
                {resetPasswordError ? (
                  <p id="wa-reset-password-error" className="wa-base-auth-field-error">
                    {resetPasswordError}
                  </p>
                ) : null}
              </label>

              <label className="wa-base-auth-label">
                <span>Повторите новый пароль</span>
                <input
                  className={resetPasswordConfirmError ? 'wa-base-auth-input is-error' : 'wa-base-auth-input'}
                  type="password"
                  value={resetPasswordConfirm}
                  onChange={(event) => handleResetPasswordConfirmChange(event.target.value)}
                  placeholder="********"
                  autoComplete="new-password"
                  aria-invalid={Boolean(resetPasswordConfirmError)}
                  aria-describedby={resetPasswordConfirmError ? 'wa-reset-password-confirm-error' : undefined}
                />
                {resetPasswordConfirmError ? (
                  <p id="wa-reset-password-confirm-error" className="wa-base-auth-field-error">
                    {resetPasswordConfirmError}
                  </p>
                ) : null}
              </label>

              <div className="wa-base-auth-actions">
                <button
                  type="button"
                  className="wa-base-auth-btn wa-base-auth-btn--primary"
                  onClick={() => void submitPasswordReset()}
                  disabled={!canSubmitResetPassword}
                >
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
    <div className="wa-ott wa-ott--studio">
      <div className="wa-studio-shell">
        <aside className="wa-studio-sidebar">
          <div className="wa-studio-brand">
            <span className="wa-studio-brand-mark" aria-hidden="true">
              ★
            </span>
            <div>
              <p className="wa-studio-brand-title">AccountTV</p>
              <p className="wa-studio-brand-subtitle">admin panel</p>
            </div>
          </div>

          <div className="wa-studio-profile">
            <span className="wa-studio-avatar" aria-hidden="true">
              {(welcomeEmail.trim().charAt(0) || 'A').toUpperCase()}
            </span>
            <div className="wa-studio-profile-main">
              <p className="wa-studio-profile-email">{welcomeEmail || 'administrator'}</p>
              <div className="wa-studio-profile-role-row">
                <p className="wa-studio-profile-role">
                  Manager
                  <span className="wa-studio-online-dot" aria-hidden="true" />
                </p>
                <button type="button" className="wa-studio-logout-btn" onClick={logout}>
                  Iesire
                </button>
              </div>
            </div>
          </div>

          <nav className="wa-studio-menu" aria-label="Studio navigation">
            <button
              type="button"
              className={studioSection === 'forms' ? 'wa-studio-menu-item is-active' : 'wa-studio-menu-item'}
              onClick={() => {
                setStudioSection('forms');
                openAddMenuItem(addMenuItem);
              }}
            >
              Adauga
            </button>
            <button
              type="button"
              className={studioSection === 'playlists' ? 'wa-studio-menu-item is-active' : 'wa-studio-menu-item'}
              onClick={() => {
                setStudioSection('playlists');
                setFocusTopic('sources');
                if (token) {
                  void Promise.all([loadPlaylistWorkspace(token), loadEpgStatus(token)]);
                }
              }}
            >
              Playlists
            </button>
            <button
              type="button"
              className={studioSection === 'constructor' ? 'wa-studio-menu-item is-active' : 'wa-studio-menu-item'}
              onClick={() => {
                setStudioSection('constructor');
                setFocusTopic('sources');
                if (token) {
                  void loadPlaylistWorkspace(token);
                }
              }}
            >
              Constructor
            </button>
            <button
              type="button"
              className={studioSection === 'account' ? 'wa-studio-menu-item is-active' : 'wa-studio-menu-item'}
              onClick={() => {
                setStudioSection('account');
                setFocusTopic('clients');
                if (token) {
                  void Promise.all([loadClients(token, selectedClientId), loadDevices(token), loadPlaylistWorkspace(token)]);
                }
              }}
            >
              Abonati Finali
            </button>
            <button
              type="button"
              className={studioSection === 'logs' ? 'wa-studio-menu-item is-active' : 'wa-studio-menu-item'}
              onClick={() => {
                setStudioSection('logs');
                setFocusTopic('history');
                if (token) {
                  void loadAuditLogs(token, {
                    section: auditSection,
                    outcome: auditSection === 'internal' ? 'error' : auditOutcome
                  });
                }
              }}
            >
              Loguri
            </button>
          </nav>
        </aside>

        <div className="wa-studio-main">
        <header className="wa-header wa-header--studio">
          <div>
            <h1>AccountTV Админ</h1>
            <p className="wa-subtitle">
              {studioSection === 'forms'
                ? 'Toate formularele de adaugare intr-un singur loc.'
                : studioSection === 'playlists'
                ? 'Vizualizare separata pentru playlisturi de baza, modificate si EPG.'
                : studioSection === 'constructor'
                ? 'Construieste un playlist nou din canalele selectate din sursele de baza.'
                : studioSection === 'account'
                    ? 'Учетные записи клиентов и лимиты устройств.'
                    : studioSection === 'logs'
                      ? 'Журнал действий администраторов и технических событий.'
                    : 'Панель управления администраторами и системным доступом.'}
            </p>
          </div>
          <div className="wa-header-right">
            <p className="wa-clock">{clockLabel}</p>
          </div>
        </header>

        <div className="wa-main wa-main--studio">
          <section className="wa-left">
            <div style={{ display: 'none' }}>
            <h2 className="wa-section-title">Администраторы</h2>

            <section
              className="wa-admin-wizard"
              onFocus={() => setFocusTopic('admins')}
              onMouseEnter={() => setFocusTopic('admins')}
              aria-label="Быстрый старт администратора"
            >
              <div className="wa-admin-wizard-head">
                <h3 className="wa-admin-wizard-title">Быстрый старт в 3 шага</h3>
                <p className="wa-admin-wizard-text">Сначала добавьте администратора, затем откройте плейлисты.</p>
              </div>

              <div className="wa-admin-wizard-steps">
                <article
                  className={
                    adminWizardStep > 1
                      ? 'wa-admin-wizard-step is-done'
                      : adminWizardStep === 1
                        ? 'wa-admin-wizard-step is-active'
                        : 'wa-admin-wizard-step'
                  }
                >
                  <span className="wa-admin-wizard-step-index">1</span>
                  <div className="wa-admin-wizard-step-main">
                    <p className="wa-admin-wizard-step-title">Отправьте код на email</p>
                    <p className="wa-admin-wizard-step-text">Заполните email + пароль и отправьте код подтверждения.</p>
                  </div>
                  <span className="wa-admin-wizard-state">{adminWizardStep > 1 ? 'Готово' : 'Текущий шаг'}</span>
                </article>

                <article
                  className={
                    adminWizardStep > 2
                      ? 'wa-admin-wizard-step is-done'
                      : adminWizardStep === 2
                        ? 'wa-admin-wizard-step is-active'
                        : 'wa-admin-wizard-step'
                  }
                >
                  <span className="wa-admin-wizard-step-index">2</span>
                  <div className="wa-admin-wizard-step-main">
                    <p className="wa-admin-wizard-step-title">Подтвердите код</p>
                    <p className="wa-admin-wizard-step-text">
                      {hasPendingAdminVerification
                        ? `Код отправлен на ${pendingAdminEmailForConfirm}. Введите 8 цифр из письма.`
                        : 'После отправки кода подтвердите нового администратора.'}
                    </p>
                  </div>
                  <span className="wa-admin-wizard-state">{adminWizardStep > 2 ? 'Готово' : adminWizardStep === 2 ? 'Текущий шаг' : 'Ожидание'}</span>
                </article>

                <article className={adminWizardStep === 3 ? 'wa-admin-wizard-step is-active' : 'wa-admin-wizard-step'}>
                  <span className="wa-admin-wizard-step-index">3</span>
                  <div className="wa-admin-wizard-step-main">
                    <p className="wa-admin-wizard-step-title">Добавьте первый плейлист</p>
                    <p className="wa-admin-wizard-step-text">
                      {hasConfirmedAdminInWizard
                        ? `Администратор добавлен: ${lastConfirmedAdminEmail || '-'}.`
                        : 'После подтверждения перейдите в раздел плейлистов.'}
                    </p>
                  </div>
                  <span className="wa-admin-wizard-state">{adminWizardStep === 3 ? 'Текущий шаг' : 'Ожидание'}</span>
                </article>
              </div>

              <div className="wa-actions">
                {adminWizardStep === 1 ? (
                  <button
                    type="button"
                    className="wa-btn wa-btn--primary"
                    onClick={() => void requestNewAdminCode()}
                    disabled={!canRequestNewAdminCode}
                  >
                    Шаг 1: отправить код
                  </button>
                ) : null}
                {adminWizardStep === 2 ? (
                  <button
                    type="button"
                    className="wa-btn wa-btn--primary"
                    onClick={() => void confirmNewAdminCode()}
                    disabled={!canConfirmNewAdminCode}
                  >
                    Шаг 2: подтвердить код
                  </button>
                ) : null}
                {adminWizardStep === 3 ? (
                  <button
                    type="button"
                    className="wa-btn wa-btn--primary"
                    onClick={continueWizardToPlaylists}
                  >
                    Шаг 3: открыть плейлисты
                  </button>
                ) : null}
              </div>
            </section>

            <section className="wa-admin-block">
              <p className="wa-admin-block-title">Создание администратора</p>

              <label
                className="wa-row"
                onFocus={() => setFocusTopic('admins')}
                onMouseEnter={() => setFocusTopic('admins')}
              >
                <span className="wa-label">Эл. почта администратора</span>
                <div className="wa-field-control">
                  <input
                    className={newAdminEmailError ? 'wa-input is-error' : 'wa-input'}
                    value={newAdminEmail}
                    onChange={(event) => handleNewAdminEmailChange(event.target.value)}
                    placeholder="admin2@example.com"
                    aria-invalid={Boolean(newAdminEmailError)}
                    aria-describedby={newAdminEmailError ? 'wa-admin-email-error' : undefined}
                  />
                  {newAdminEmailError ? (
                    <p id="wa-admin-email-error" className="wa-field-error">
                      {newAdminEmailError}
                    </p>
                  ) : null}
                </div>
              </label>

              <label
                className="wa-row"
                onFocus={() => setFocusTopic('admins')}
                onMouseEnter={() => setFocusTopic('admins')}
              >
                <span className="wa-label">Пароль admin</span>
                <div className="wa-field-control">
                  <input
                    className={newAdminPasswordError ? 'wa-input is-error' : 'wa-input'}
                    type="password"
                    value={newAdminPassword}
                    onChange={(event) => handleNewAdminPasswordChange(event.target.value)}
                    placeholder="minimum 8 characters"
                    aria-invalid={Boolean(newAdminPasswordError)}
                    aria-describedby={newAdminPasswordError ? 'wa-admin-password-error' : undefined}
                  />
                  {newAdminPasswordError ? (
                    <p id="wa-admin-password-error" className="wa-field-error">
                      {newAdminPasswordError}
                    </p>
                  ) : null}
                </div>
              </label>

              <label
                className="wa-row"
                onFocus={() => setFocusTopic('admins')}
                onMouseEnter={() => setFocusTopic('admins')}
              >
                <span className="wa-label">Код подтверждения</span>
                <div className="wa-field-control">
                  <input
                    className={newAdminCodeError ? 'wa-input is-error' : 'wa-input'}
                    value={newAdminCode}
                    onChange={(event) => handleNewAdminCodeChange(event.target.value)}
                    placeholder="8 digits from email"
                    inputMode="numeric"
                    maxLength={8}
                    aria-invalid={Boolean(newAdminCodeError)}
                    aria-describedby={newAdminCodeError ? 'wa-admin-code-error' : undefined}
                  />
                  {newAdminCodeError ? (
                    <p id="wa-admin-code-error" className="wa-field-error">
                      {newAdminCodeError}
                    </p>
                  ) : null}
                </div>
              </label>

              <div
                className="wa-row wa-row--actions"
                onFocus={() => setFocusTopic('admins')}
                onMouseEnter={() => setFocusTopic('admins')}
              >
                <span className="wa-label">Действия администратора</span>
                <div className="wa-actions">
                  <button
                    type="button"
                    className="wa-btn wa-btn--primary"
                    onClick={() => void requestNewAdminCode()}
                    disabled={!canRequestNewAdminCode}
                  >
                    Отправить код
                  </button>
                  <button
                    type="button"
                    className="wa-btn"
                    onClick={() => void resendNewAdminCode()}
                    disabled={!canResendNewAdminCode}
                  >
                    {newAdminResendCooldownSec > 0
                      ? `Повторно отправить (${formatCountdown(newAdminResendCooldownSec)})`
                      : 'Повторно отправить код'}
                  </button>
                  <button
                    type="button"
                    className="wa-btn wa-btn--primary"
                    onClick={() => void confirmNewAdminCode()}
                    disabled={!canConfirmNewAdminCode}
                  >
                    Подтвердить и добавить
                  </button>
                  <button type="button" className="wa-btn" onClick={() => void loadAdmins()} disabled={adminsBusy}>
                    {adminsBusy ? 'Обновление...' : 'Обновить админов'}
                  </button>
                </div>
              </div>
            </section>

            <section className="wa-admin-block">
              <p className="wa-admin-block-title">Список администраторов</p>

              <div
                className="wa-row wa-row--actions"
                onFocus={() => setFocusTopic('admins')}
                onMouseEnter={() => setFocusTopic('admins')}
              >
                <span className="wa-label">Фильтр и сортировка</span>
                <div className="wa-admin-toolbar">
                  <div className="wa-admin-toolbar-controls">
                    <input
                      className="wa-input"
                      value={adminSearchQuery}
                      onChange={(event) => setAdminSearchQuery(event.target.value)}
                      placeholder="Поиск по email"
                    />
                    <select
                      className="wa-input wa-select"
                      value={adminSortMode}
                      onChange={(event) => setAdminSortMode(event.target.value as AdminSortMode)}
                    >
                      <option value="newest">Сначала новые</option>
                      <option value="oldest">Сначала старые</option>
                      <option value="email">Email A-Z</option>
                    </select>
                  </div>
                  <p className="wa-admin-toolbar-meta">
                    Показано: {filteredAdmins.length} из {admins.length}. Последний добавлен: {formatDateTime(newestAdminCreatedAt)}
                  </p>
                </div>
              </div>

              <div
                className="wa-admin-list"
                onFocus={() => setFocusTopic('admins')}
                onMouseEnter={() => setFocusTopic('admins')}
              >
                {admins.length <= 1 ? (
                  <p className="wa-admin-meta wa-admin-meta--hint">Удаление отключено: минимум один администратор обязателен.</p>
                ) : null}
                {filteredAdmins.length === 0 ? (
                  <p className="wa-empty">
                    {adminSearchQuery.trim() ? 'По вашему фильтру администраторы не найдены.' : 'Администраторы отсутствуют.'}
                  </p>
                ) : (
                  filteredAdmins.map((admin) => {
                    const isCurrentAdmin = currentAdminEmail.length > 0 && admin.email.toLowerCase() === currentAdminEmail;
                    return (
                      <article key={admin.id} className="wa-admin-item">
                        <div className="wa-admin-item-head">
                          <p className="wa-admin-email">{admin.email}</p>
                          {isCurrentAdmin ? <span className="wa-pill wa-pill--admin">Текущий вход</span> : null}
                        </div>
                        <p className="wa-admin-meta">Создан: {formatDateTime(admin.createdAt)}</p>
                        <div className="wa-actions">
                          <button type="button" className="wa-btn" onClick={() => void copyAdminEmail(admin.email)}>
                            {copiedAdminEmail === admin.email ? 'Скопировано' : 'Копировать email'}
                          </button>
                          <button
                            type="button"
                            className="wa-btn wa-btn--ghost"
                            onClick={() => void deleteAdmin(admin)}
                            disabled={adminsBusy || isCurrentAdmin || admins.length <= 1}
                          >
                            Удалить админа
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
            </div>

            <section className="wa-admin-block" style={studioSection === 'forms' ? undefined : { display: 'none' }}>
              <h2 className="wa-section-title">Formulare De Adaugare</h2>
              <div className="wa-add-top-menu" role="tablist" aria-label="Tip formular">
                <button
                  type="button"
                  className={addMenuItem === 'playlist' ? 'wa-add-top-menu-item is-active' : 'wa-add-top-menu-item'}
                  onClick={() => openAddMenuItem('playlist')}
                >
                  Playlist
                </button>
                <button
                  type="button"
                  className={addMenuItem === 'subscriber' ? 'wa-add-top-menu-item is-active' : 'wa-add-top-menu-item'}
                  onClick={() => openAddMenuItem('subscriber')}
                >
                  Abonat
                </button>
              </div>

              <section className="wa-base-playlists-panel" style={addMenuItem === 'playlist' ? undefined : { display: 'none' }}>
                <h3 className="wa-base-playlists-panel-title">Adauga Playlist De Baza</h3>
                <p className="wa-add-playlist-focus-text">
                  Prim plan: completeaza denumirea si URL-ul playlistului de baza sau incarca un fisier M3U/M3U8. Managementul avansat ramane in tabul
                  Playlists.
                </p>
                <label className="wa-row">
                  <span className="wa-label">Nume playlist</span>
                  <input
                    className="wa-input"
                    value={playlistSourceName}
                    onChange={(event) => setPlaylistSourceName(event.target.value)}
                    placeholder="Starter Package"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">URL playlist (M3U/M3U8)</span>
                  <input
                    className="wa-input"
                    value={playlistUrl}
                    onChange={(event) => setPlaylistUrl(event.target.value)}
                    placeholder="https://example.com/playlist.m3u8"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">sau fisier playlist (M3U/M3U8)</span>
                  <input
                    key={`forms-playlist-file-${playlistFileInputVersion}`}
                    className="wa-input"
                    type="file"
                    accept=".m3u,.m3u8,text/plain,application/x-mpegURL,audio/x-mpegurl"
                    onChange={(event) => setPlaylistFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                <p className="wa-base-playlists-meta">Daca alegi fisierul, URL-ul nu se foloseste.</p>
                {playlistFile ? <p className="wa-base-playlists-meta">Fisier selectat: {playlistFile.name}</p> : null}
                <div className="wa-row wa-row--actions">
                  <span className="wa-label">Actiuni</span>
                  <div className="wa-actions">
                    <button type="button" className="wa-btn wa-btn--primary" onClick={() => void savePlaylist()} disabled={playlistBusy}>
                      {playlistBusy ? 'Salvare...' : 'Adauga playlist'}
                    </button>
                    <button
                      type="button"
                      className="wa-btn"
                      onClick={() => {
                        setPlaylistSourceName('');
                        setPlaylistUrl('');
                        setPlaylistFile(null);
                        setPlaylistFileInputVersion((value) => value + 1);
                      }}
                      disabled={playlistBusy || (!playlistSourceName.trim() && !playlistUrl.trim() && !playlistFile)}
                    >
                      Curata campurile
                    </button>
                    <button type="button" className="wa-btn" onClick={() => void loadPlaylistWorkspace(undefined, true)} disabled={playlistBusy}>
                      {playlistBusy ? 'Verificare...' : 'Refresh'}
                    </button>
                  </div>
                </div>
              </section>

              <section className="wa-base-playlists-panel" style={addMenuItem === 'subscriber' ? undefined : { display: 'none' }}>
                <h3 className="wa-base-playlists-panel-title">Adauga Abonat Final</h3>
                <label className="wa-row">
                  <span className="wa-label">Cod Pair de la TV</span>
                  <input
                    className="wa-input"
                    value={pairCode}
                    onChange={(event) =>
                      setPairCode(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 8)
                      )
                    }
                    placeholder="A1B2C3"
                    maxLength={8}
                  />
                </label>
                <p className="wa-base-playlists-meta">
                  Primul pas: introdu codul Pair de pe TV (sau deschide linkul din QR). Apoi creezi abonatul.
                </p>
                <label className="wa-row">
                  <span className="wa-label">Nume</span>
                  <input
                    className="wa-input"
                    value={clientFirstName}
                    onChange={(event) => setClientFirstName(event.target.value)}
                    placeholder="John"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">Prenume</span>
                  <input
                    className="wa-input"
                    value={clientLastName}
                    onChange={(event) => setClientLastName(event.target.value)}
                    placeholder="Smith"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">Telefon</span>
                  <input
                    className="wa-input"
                    value={clientPhone}
                    onChange={(event) => setClientPhone(event.target.value)}
                    placeholder="+373 60 123 456"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">Adresa</span>
                  <input
                    className="wa-input"
                    value={clientAddress}
                    onChange={(event) => setClientAddress(event.target.value)}
                    placeholder="City, street, house"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">Nr. dispozitive</span>
                  <input
                    className="wa-input"
                    value={clientDevicesAllowed}
                    onChange={(event) => setClientDevicesAllowed(event.target.value)}
                    placeholder="1"
                  />
                </label>
                <label className="wa-row">
                  <span className="wa-label">Playlisturi active abonat</span>
                  <select
                    className="wa-input"
                    multiple
                    value={clientSourcePlaylistIds}
                    onChange={(event) =>
                      setClientSourcePlaylistIds(Array.from(event.target.selectedOptions).map((option) => option.value))
                    }
                  >
                    {sourcePlaylistSelectionOptions.length === 0 ? (
                      <option value="" disabled>
                        Nu exista surse de baza
                      </option>
                    ) : (
                      sourcePlaylistSelectionOptions.map((option) => (
                        <option key={option.playlistId} value={option.playlistId}>
                          {option.label}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <p className="wa-base-playlists-meta">
                  Active acum:{' '}
                  {clientSourcePlaylistIds.length === 0
                    ? 'toate sursele de baza'
                    : basePlaylists
                        .filter((playlist) => clientSourcePlaylistIds.includes(playlist.id))
                        .map((playlist) => playlist.name)
                        .join(', ') || 'niciun playlist valid selectat'}
                </p>
                <label className="wa-row">
                  <span className="wa-label">Playlist la Pair</span>
                  <select
                    className="wa-input"
                    value={pairPlaylistSelection}
                    onChange={(event) => setPairPlaylistSelectionValue(event.target.value)}
                  >
                    {playlistSelectionOptions.length === 0 ? (
                      <option value="">Nu exista playlisturi</option>
                    ) : (
                      <>
                        {sourcePlaylistSelectionOptions.length > 0 ? (
                          <>
                            <option value={SUBSCRIBER_SOURCE_SELECTION_VALUE}>Playlisturile abonatului (multiple)</option>
                            <optgroup label="Surse de baza">
                              {sourcePlaylistSelectionOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </optgroup>
                          </>
                        ) : null}
                        {customPlaylistSelectionOptions.length > 0 ? (
                          <optgroup label="Constructor custom">
                            {customPlaylistSelectionOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                      </>
                    )}
                  </select>
                </label>
                <div className="wa-row wa-row--actions">
                  <span className="wa-label">Actiuni</span>
                  <div className="wa-actions">
                    <button type="button" className="wa-btn wa-btn--primary" onClick={() => void createClient()}>
                      {pairCode.trim() ? 'Adauga abonat + Pair TV' : 'Adauga abonat'}
                    </button>
                    <button type="button" className="wa-btn" onClick={() => void loadClients()} disabled={clientBusy}>
                      {clientBusy ? 'Actualizare...' : 'Refresh abonati'}
                    </button>
                  </div>
                </div>
                <p className="wa-base-playlists-meta">La Pair, device-ul primeste playlistul ales mai sus.</p>
              </section>
            </section>

            <section className="wa-base-playlists" aria-label="Плейлисты" style={studioSection === 'playlists' ? undefined : { display: 'none' }}>
              <div className="wa-base-playlists-head">
                <h2 className="wa-base-playlists-title">Playlists</h2>
                <button type="button" className="wa-btn" onClick={() => void loadPlaylistWorkspace(undefined, true)} disabled={playlistBusy}>
                  {playlistBusy ? 'Проверка...' : 'Обновить данные'}
                </button>
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
              </div>

              {playlistStatus?.sourceLastError ? (
                <p className="wa-base-playlists-error">Ошибка источника: {playlistStatus.sourceLastError}</p>
              ) : null}

              <div className="wa-playlists-submenu" role="tablist" aria-label="Submeniu playlists">
                <button
                  type="button"
                  className={playlistsSubMenuItem === 'base' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                  onClick={() => setPlaylistsSubMenuItem('base')}
                >
                  Playlisturi de baza
                </button>
                <button
                  type="button"
                  className={playlistsSubMenuItem === 'modified' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                  onClick={() => setPlaylistsSubMenuItem('modified')}
                >
                  Playlisturi modificate
                </button>
                <button
                  type="button"
                  className={playlistsSubMenuItem === 'epg' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                  onClick={() => setPlaylistsSubMenuItem('epg')}
                >
                  EPG
                </button>
              </div>

              <section className="wa-base-playlists-panel" style={playlistsSubMenuItem === 'base' ? undefined : { display: 'none' }}>
                <h3 className="wa-base-playlists-panel-title">Playlisturi de baza</h3>
                {basePlaylists.length === 0 ? (
                  <p className="wa-empty">Nu exista playlisturi de baza.</p>
                ) : (
                  <div className="wa-base-playlists-custom-list">
                    {basePlaylists.map((playlist) => (
                      <article key={playlist.id} className="wa-base-playlists-custom-item">
                        <p className="wa-base-playlists-custom-item-name">{playlist.name}</p>
                        <p className="wa-base-playlists-custom-item-meta">
                          {playlist.sourceType === 'file'
                            ? `Fisier: ${playlist.fileName ?? 'uploaded-playlist.m3u8'}`
                            : playlist.url}
                        </p>
                        <p className="wa-base-playlists-custom-item-meta">
                          canale: {playlist.channelsCount} | actualizat: {formatDateTime(playlist.cacheUpdatedAt)}
                        </p>
                        <div className="wa-actions">
                          <button
                            type="button"
                            className="wa-btn"
                            onClick={() => void refreshBasePlaylist(playlist.id, playlist.name)}
                            disabled={playlistBusy || playlist.sourceType === 'file'}
                            title={
                              playlist.sourceType === 'file'
                                ? 'Sursa a fost adaugata din fisier. Pentru actualizare, incarca un nou fisier.'
                                : undefined
                            }
                          >
                            Refresh
                          </button>
                          <button type="button" className="wa-btn" onClick={() => void renameBasePlaylist(playlist)} disabled={playlistBusy}>
                            Redenumeste
                          </button>
                          <button type="button" className="wa-btn" onClick={() => void updateBasePlaylistUrl(playlist)} disabled={playlistBusy}>
                            Schimba URL
                          </button>
                          <button type="button" className="wa-btn wa-btn--ghost" onClick={() => void deleteBasePlaylist(playlist)} disabled={playlistBusy}>
                            Sterge
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="wa-base-playlists-panel" style={playlistsSubMenuItem === 'modified' ? undefined : { display: 'none' }}>
                <h3 className="wa-base-playlists-panel-title">Playlisturi modificate (custom)</h3>
                {customPlaylists.length === 0 ? (
                  <p className="wa-empty">Nu exista playlisturi modificate.</p>
                ) : (
                  <div className="wa-base-playlists-custom-list">
                    {customPlaylists.map((playlist) => (
                      <button
                        key={playlist.id}
                        type="button"
                        className={playlist.id === selectedCustomPlaylistId ? 'wa-base-playlists-custom-item is-active' : 'wa-base-playlists-custom-item'}
                        onClick={() => void loadCustomPlaylistById(playlist.id)}
                        disabled={playlistBusy}
                      >
                        <p className="wa-base-playlists-custom-item-name">{playlist.name}</p>
                        <p className="wa-base-playlists-custom-item-meta">
                          canale: {playlist.channelsCount} | {playlist.isActive ? 'activ' : 'inactiv'}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="wa-base-playlists-panel" style={playlistsSubMenuItem === 'epg' ? undefined : { display: 'none' }}>
                <h3 className="wa-base-playlists-panel-title">EPG separat</h3>
                <p className="wa-base-playlists-meta">
                  Sectiune separata pentru EPG: setezi URL-ul EPG sau faci upload manual `.gz`.
                </p>
                <p className="wa-base-playlists-meta">Sursa curenta: {epgStatus?.sourceUrl ?? '-'}</p>
                <p className="wa-base-playlists-meta">
                  Ultimul ingest: {formatDateTime(epgStatus?.sourceLastIngestedAt ?? null)} | Snapshot canale:{' '}
                  {epgStatus?.snapshotChannels ?? 0}
                </p>
                <p className="wa-base-playlists-meta">
                  Ultimul snapshot reusit: {formatDateTime(epgStatus?.snapshotLastSuccessfulIngest ?? null)}
                </p>

                {epgStatus?.sourceLastError ? (
                  <p className="wa-base-playlists-error">Eroare EPG: {epgStatus.sourceLastError}</p>
                ) : null}

                <label className="wa-row">
                  <span className="wa-label">URL EPG (xml/xml.gz, unul sau mai multe)</span>
                  <textarea
                    className="wa-input"
                    value={epgSourceUrl}
                    onChange={(event) => setEpgSourceUrl(event.target.value)}
                    placeholder={'https://example.com/epg.xml.gz\nhttps://iptv-epg.org/guides'}
                    rows={4}
                  />
                  <span className="wa-base-playlists-meta">
                    Pune cate un URL pe linie pentru acoperire mai mare.
                  </span>
                </label>

                <label className="wa-row">
                  <span className="wa-label">Upload manual EPG (.gz)</span>
                  <input
                    key={`playlists-epg-file-${epgFileInputVersion}`}
                    className="wa-input"
                    type="file"
                    accept=".gz,application/gzip,application/x-gzip"
                    onChange={(event) => setEpgGzipFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                {epgGzipFile ? <p className="wa-base-playlists-meta">Fisier EPG selectat: {epgGzipFile.name}</p> : null}

                <div className="wa-row wa-row--actions">
                  <span className="wa-label">Actiuni EPG</span>
                  <div className="wa-actions">
                    <button
                      type="button"
                      className="wa-btn wa-btn--primary"
                      onClick={() => void saveEpgSourceUrl()}
                      disabled={epgBusy || !epgSourceUrl.trim()}
                    >
                      {epgBusy ? 'Salvare...' : 'Salveaza URL EPG'}
                    </button>
                    <button
                      type="button"
                      className="wa-btn"
                      onClick={() => void uploadEpgGzipFile()}
                      disabled={epgBusy || !epgGzipFile}
                    >
                      {epgBusy ? 'Upload...' : 'Upload EPG .gz'}
                    </button>
                    <button
                      type="button"
                      className="wa-btn"
                      onClick={() => void loadEpgStatus(undefined, true)}
                      disabled={epgBusy}
                    >
                      {epgBusy ? 'Verificare...' : 'Refresh EPG'}
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section className="wa-base-playlists" aria-label="Constructor playlist" style={studioSection === 'constructor' ? undefined : { display: 'none' }}>
              <div className="wa-base-playlists-head">
                <h2 className="wa-base-playlists-title">Constructor Playlist</h2>
                <button type="button" className="wa-btn" onClick={() => void loadPlaylistWorkspace(undefined, true)} disabled={playlistBusy}>
                  {playlistBusy ? 'Verificare...' : 'Refresh date'}
                </button>
              </div>
              <p className="wa-base-playlists-text">
                Creeaza de la zero playlistul dorit: selecteaza sau creeaza un custom playlist, apoi adauga canale din playlisturile de baza.
              </p>

              {token ? (
                <div className="wa-base-playlists-manager">
                  <section className="wa-base-playlists-panel">
                    <h3 className="wa-base-playlists-panel-title">Playlisturi modificate</h3>

                    <label className="wa-row wa-constructor-create-card">
                      <span className="wa-label">Nume playlist nou</span>
                      <div className="wa-field-control">
                        <input
                          className="wa-input"
                          value={newCustomPlaylistName}
                          onChange={(event) => setNewCustomPlaylistName(event.target.value)}
                          placeholder="Ex: Sport + Cinema"
                        />
                        <div className="wa-actions wa-constructor-create-actions">
                          <button type="button" className="wa-btn wa-btn--primary" onClick={() => void createCustomPlaylist()} disabled={playlistBusy}>
                            Creeaza
                          </button>
                          <button type="button" className="wa-btn" onClick={() => void loadPlaylistWorkspace(undefined, true)} disabled={playlistBusy}>
                            Refresh
                          </button>
                        </div>
                      </div>
                    </label>

                    {customPlaylists.length === 0 ? (
                      <p className="wa-empty">Nu exista playlisturi modificate.</p>
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
                              canale: {playlist.channelsCount} | {playlist.isActive ? 'activ' : 'inactiv'}
                            </p>
                            <p className="wa-base-playlists-custom-item-meta">
                              surse: {playlist.sourcePlaylistNames.length > 0 ? playlist.sourcePlaylistNames.join(', ') : '-'}
                            </p>
                          </button>
                        ))}
                      </div>
                    )}

                    {selectedCustomPlaylist ? (
                      <div className="wa-base-playlists-editor">
                        <label className="wa-row">
                          <span className="wa-label">Denumire playlist</span>
                          <div className="wa-field-control">
                            <input
                              className="wa-input"
                              value={selectedCustomPlaylistName}
                              onChange={(event) => setSelectedCustomPlaylistName(event.target.value)}
                              placeholder="Nume playlist"
                            />
                            <div className="wa-actions">
                              <button type="button" className="wa-btn" onClick={() => void renameSelectedCustomPlaylist()} disabled={playlistBusy}>
                                Redenumeste
                              </button>
                              <button type="button" className="wa-btn wa-btn--ghost" onClick={() => void deleteSelectedCustomPlaylist()} disabled={playlistBusy}>
                                Sterge
                              </button>
                              <button type="button" className="wa-btn wa-btn--primary" onClick={() => void saveCustomPlaylistDraft()} disabled={playlistBusy}>
                                Salveaza canale
                              </button>
                              <button
                                type="button"
                                className="wa-btn"
                                onClick={() => setCustomDraftChannelIds(customSavedChannelIds)}
                                disabled={playlistBusy || !hasCustomDraftChanges}
                              >
                                Renunta modificari
                              </button>
                              <button type="button" className="wa-btn" onClick={() => void activateSelectedCustomPlaylist()} disabled={playlistBusy}>
                                Activeaza
                              </button>
                            </div>
                          </div>
                        </label>

                        <p className="wa-base-playlists-meta">
                          Canale in draft: {customDraftChannels.length}
                          {hasCustomDraftChanges ? ' (ai modificari nesalvate)' : ''}
                        </p>
                        <p className="wa-base-playlists-meta">
                          Surse curente: {selectedCustomPlaylist.sourcePlaylistNames.length > 0 ? selectedCustomPlaylist.sourcePlaylistNames.join(', ') : '-'}
                        </p>

                        {customDraftChannels.length === 0 ? (
                          <p className="wa-empty">Acest playlist nu are inca canale.</p>
                        ) : (
                          <div className="wa-base-playlists-draft-list">
                            {customDraftChannels.map((channel, index) => (
                              <div key={channel.id} className="wa-base-playlists-draft-item">
                                <div className="wa-base-playlists-draft-main">
                                  <p className="wa-base-playlists-draft-name">{index + 1}. {channel.name}</p>
                                  <p className="wa-base-playlists-draft-meta">
                                    {channel.group || 'fara grup'} | {channel.tvgId || '-'}
                                  </p>
                                </div>
                                <div className="wa-base-playlists-draft-actions">
                                  <button type="button" className="wa-btn" onClick={() => moveDraftChannel(index, -1)} disabled={playlistBusy || index === 0}>
                                    Sus
                                  </button>
                                  <button
                                    type="button"
                                    className="wa-btn"
                                    onClick={() => moveDraftChannel(index, 1)}
                                    disabled={playlistBusy || index === customDraftChannels.length - 1}
                                  >
                                    Jos
                                  </button>
                                  <button type="button" className="wa-btn wa-btn--ghost" onClick={() => removeDraftChannel(channel.id)} disabled={playlistBusy}>
                                    Scoate
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
                    <h3 className="wa-base-playlists-panel-title">Canale din playlisturile de baza</h3>

                    <label className="wa-row">
                      <span className="wa-label">Cauta canal</span>
                      <input
                        className="wa-input"
                        value={playlistSourceSearch}
                        onChange={(event) => setPlaylistSourceSearch(event.target.value)}
                        placeholder="nume canal, grup, tvg-id"
                      />
                    </label>

                    <div className="wa-row wa-row--actions">
                      <span className="wa-label">Selectie</span>
                      <div className="wa-actions">
                        <button type="button" className="wa-btn" onClick={selectAllFilteredSourceChannels} disabled={playlistBusy || filteredSourceChannels.length === 0}>
                          Selecteaza tot
                        </button>
                        <button type="button" className="wa-btn" onClick={clearSourceChannelSelection} disabled={playlistBusy || selectedSourceChannelIds.length === 0}>
                          Curata selectia
                        </button>
                        <button
                          type="button"
                          className="wa-btn wa-btn--primary"
                          onClick={addSelectedChannelsToCustomDraft}
                          disabled={playlistBusy || selectedSourceChannelIds.length === 0 || !selectedCustomPlaylistId}
                        >
                          Adauga in playlistul selectat
                        </button>
                      </div>
                    </div>

                    <p className="wa-base-playlists-meta">
                      Canale gasite: {filteredSourceChannels.length}. Selectate: {selectedSourceChannelIds.length}.
                    </p>

                    {filteredSourceChannels.length === 0 ? (
                      <p className="wa-empty">Nu au fost gasite canale. Verifica sursele de baza si da refresh.</p>
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
                                  {channel.group || 'fara grup'} | {channel.tvgId || '-'} | {channel.sourcePlaylistNames.join(', ')}
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
              ) : (
                <div className="wa-base-playlists-empty">
                  <p className="wa-base-playlists-empty-text">Pentru constructor trebuie sa te loghezi ca administrator.</p>
                  <button type="button" className="wa-base-auth-btn wa-base-auth-btn--primary" onClick={openLandingAuth}>
                    Login admin
                  </button>
                </div>
              )}
            </section>

            <section className="wa-base-subscribers" aria-label="Account" style={studioSection === 'account' ? undefined : { display: 'none' }}>
              <div className="wa-base-subscribers-head">
                <h2 className="wa-base-subscribers-title">Abonati Finali</h2>
              </div>
              <p className="wa-base-subscribers-text">Aici gestionezi abonatii, device-urile si playlisturile fara blocuri duplicate.</p>
              <div className="wa-actions">
                <button type="button" className="wa-btn" onClick={() => void loadClients()} disabled={clientBusy}>
                  {clientBusy ? 'Обновление...' : 'Обновить список'}
                </button>
                <button type="button" className="wa-btn" onClick={() => void loadDevices()} disabled={devicesBusy}>
                  {devicesBusy ? 'Actualizare...' : 'Refresh devices'}
                </button>
              </div>

              <div className="wa-base-subscribers-list">
                <p className="wa-base-subscribers-list-title">Список абонентов + device-uri</p>
                {clients.length === 0 ? (
                  <p className="wa-empty">Список абонентов пока пуст.</p>
                ) : (
                  <div className="wa-base-devices-client-list">
                    {clients.map((client) => {
                      const isOpen = expandedFinalClientId === client.id;
                      const draft = finalClientDrafts[client.id] ?? toFinalClientDraft(client);
                      const parsedDraftDevices = Number.parseInt(draft.devicesAllowed.trim(), 10);
                      const isDraftValid = Number.isFinite(parsedDraftDevices) && parsedDraftDevices >= 1;
                      const hasDraftChanges =
                        draft.firstName !== client.firstName ||
                        draft.lastName !== client.lastName ||
                        draft.phone !== client.phone ||
                        draft.address !== client.address ||
                        (isDraftValid
                          ? parsedDraftDevices !== client.devicesAllowed
                          : draft.devicesAllowed.trim() !== String(client.devicesAllowed)) ||
                        !areStringArraysEqual(draft.sourcePlaylistIds, client.sourcePlaylistIds);
                      const clientDevices = pairedDevicesByClient.byClientId.get(client.id) ?? [];

                      return (
                        <article key={client.id} className={isOpen ? 'wa-base-devices-client is-open' : 'wa-base-devices-client'}>
                          <button
                            type="button"
                            className="wa-base-devices-client-toggle"
                            onClick={() => toggleFinalClientCard(client)}
                            aria-expanded={isOpen}
                          >
                            <span className="wa-base-devices-client-name">
                              {client.lastName} {client.firstName}
                            </span>
                            <span className="wa-base-devices-client-meta">
                              {client.phone} | device-uri: {clientDevices.length}/{client.devicesAllowed} | playlisturi active:{' '}
                              {client.sourcePlaylistIds.length === 0 ? 'toate' : client.sourcePlaylistIds.length}
                            </span>
                          </button>

                          {isOpen ? (
                            <div className="wa-base-devices-list-grid">
                              <article className="wa-base-devices-item">
                                <p className="wa-base-devices-item-name">Setari abonat</p>
                                <p className="wa-base-devices-item-meta">Complete: toate campurile din Adauga Abonat</p>

                                <label className="wa-row">
                                  <span className="wa-label">Nume</span>
                                  <input
                                    className="wa-input"
                                    value={draft.firstName}
                                    onChange={(event) => setFinalClientDraftField(client.id, 'firstName', event.target.value)}
                                    placeholder="John"
                                  />
                                </label>
                                <label className="wa-row">
                                  <span className="wa-label">Prenume</span>
                                  <input
                                    className="wa-input"
                                    value={draft.lastName}
                                    onChange={(event) => setFinalClientDraftField(client.id, 'lastName', event.target.value)}
                                    placeholder="Smith"
                                  />
                                </label>
                                <label className="wa-row">
                                  <span className="wa-label">Telefon</span>
                                  <input
                                    className="wa-input"
                                    value={draft.phone}
                                    onChange={(event) => setFinalClientDraftField(client.id, 'phone', event.target.value)}
                                    placeholder="+373 60 123 456"
                                  />
                                </label>
                                <label className="wa-row">
                                  <span className="wa-label">Adresa</span>
                                  <input
                                    className="wa-input"
                                    value={draft.address}
                                    onChange={(event) => setFinalClientDraftField(client.id, 'address', event.target.value)}
                                    placeholder="City, street, house"
                                  />
                                </label>
                                <label className="wa-row">
                                  <span className="wa-label">Nr. dispozitive</span>
                                  <input
                                    className="wa-input"
                                    value={draft.devicesAllowed}
                                    onChange={(event) => setFinalClientDraftField(client.id, 'devicesAllowed', event.target.value)}
                                    inputMode="numeric"
                                    placeholder="1"
                                  />
                                </label>
                                <label className="wa-row">
                                  <span className="wa-label">Playlisturi active abonat</span>
                                  <select
                                    className="wa-input"
                                    multiple
                                    value={draft.sourcePlaylistIds}
                                    onChange={(event) =>
                                      setFinalClientDraftSourcePlaylists(
                                        client.id,
                                        Array.from(event.target.selectedOptions).map((option) => option.value)
                                      )
                                    }
                                  >
                                    {sourcePlaylistSelectionOptions.length === 0 ? (
                                      <option value="" disabled>
                                        Nu exista surse de baza
                                      </option>
                                    ) : (
                                      sourcePlaylistSelectionOptions.map((option) => (
                                        <option key={option.playlistId} value={option.playlistId}>
                                          {option.label}
                                        </option>
                                      ))
                                    )}
                                  </select>
                                </label>
                                <p className="wa-base-devices-item-meta">
                                  Active acum:{' '}
                                  {draft.sourcePlaylistIds.length === 0
                                    ? 'toate sursele de baza'
                                    : basePlaylists
                                        .filter((playlist) => draft.sourcePlaylistIds.includes(playlist.id))
                                        .map((playlist) => playlist.name)
                                        .join(', ') || 'niciun playlist valid selectat'}
                                </p>

                                <div className="wa-actions">
                                  <button
                                    type="button"
                                    className="wa-btn wa-btn--primary"
                                    onClick={() => void saveFinalClient(client)}
                                    disabled={clientBusy || !isDraftValid || !hasDraftChanges}
                                  >
                                    Modifica
                                  </button>
                                  <button
                                    type="button"
                                    className="wa-btn wa-btn--ghost"
                                    onClick={() => void deleteClient(client)}
                                    disabled={clientBusy}
                                  >
                                    Sterge abonat
                                  </button>
                                  <button
                                    type="button"
                                    className="wa-btn"
                                    onClick={() => resetFinalClientDraft(client)}
                                    disabled={clientBusy || !hasDraftChanges}
                                  >
                                    Reset
                                  </button>
                                </div>
                              </article>

                              <article className="wa-base-devices-item">
                                <p className="wa-base-devices-item-name">Device-uri abonat</p>
                                {clientDevices.length === 0 ? (
                                  <p className="wa-empty">Acest abonat nu are inca device-uri.</p>
                                ) : (
                                  <div className="wa-base-devices-list-grid">
                                    {clientDevices.map((device) => {
                                      const draft = getDevicePlaylistDraft(device);
                                      const hasDraftPlaylistChanges =
                                        draft.mode !== normalizeDeviceModeForSelection(device.playlistMode) ||
                                        (draft.mode === 'CUSTOM'
                                          ? draft.customPlaylistId !== (device.customPlaylistId ?? '')
                                          : draft.customPlaylistId !== (device.sourcePlaylistId ?? device.customPlaylistId ?? ''));

                                      return (
                                        <article key={device.id} className="wa-base-devices-item">
                                          <p className="wa-base-devices-item-name">{device.name}</p>
                                          <p className="wa-base-devices-item-meta">
                                            {formatDeviceIdentity(device)}
                                          </p>
                                          <p className="wa-base-devices-item-meta">
                                            Client: {device.clientName || 'fara abonat'}
                                          </p>
                                          <p className="wa-base-devices-item-meta">
                                            Pair: {formatDateTime(device.pairedAt)} | Online: {formatDateTime(device.lastSeenAt)}
                                          </p>
                                          <p className="wa-base-devices-item-meta">
                                            Playlist actual: {getDeviceCurrentPlaylistLabel(device)}
                                          </p>

                                          <label className="wa-row">
                                            <span className="wa-label">Playlist dorit</span>
                                            <select
                                              className="wa-input"
                                              value={getDevicePlaylistSelectionValue(device)}
                                              onChange={(event) => setDevicePlaylistSelectionValue(device.id, event.target.value)}
                                            >
                                              {playlistSelectionOptions.length === 0 ? (
                                                <option value="">Nu exista playlisturi</option>
                                              ) : (
                                                <>
                                                  {sourcePlaylistSelectionOptions.length > 0 ? (
                                                    <>
                                                      <option value={SUBSCRIBER_SOURCE_SELECTION_VALUE}>Playlisturile abonatului (multiple)</option>
                                                      <optgroup label="Surse de baza">
                                                        {sourcePlaylistSelectionOptions.map((option) => (
                                                          <option key={option.value} value={option.value}>
                                                            {option.label}
                                                          </option>
                                                        ))}
                                                      </optgroup>
                                                    </>
                                                  ) : null}
                                                  {customPlaylistSelectionOptions.length > 0 ? (
                                                    <optgroup label="Constructor custom">
                                                      {customPlaylistSelectionOptions.map((option) => (
                                                        <option key={option.value} value={option.value}>
                                                          {option.label}
                                                        </option>
                                                      ))}
                                                    </optgroup>
                                                  ) : null}
                                                </>
                                              )}
                                            </select>
                                          </label>

                                          <div className="wa-actions">
                                            <button
                                              type="button"
                                              className="wa-btn wa-btn--primary"
                                              onClick={() => void saveDevicePlaylistAssignment(device)}
                                              disabled={devicesBusy || !hasDraftPlaylistChanges}
                                            >
                                              Salveaza playlist
                                            </button>
                                          </div>
                                        </article>
                                      );
                                    })}
                                  </div>
                                )}
                              </article>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                )}
                {pairedDevicesByClient.unassigned.length > 0 ? (
                  <div className="wa-base-devices-list">
                    <p className="wa-base-devices-list-title">Device-uri fara abonat</p>
                    <div className="wa-base-devices-list-grid">
                      {pairedDevicesByClient.unassigned.map((device) => (
                        <article key={device.id} className="wa-base-devices-item">
                          <p className="wa-base-devices-item-name">{device.name}</p>
                          <p className="wa-base-devices-item-meta">{formatDeviceIdentity(device)}</p>
                          <p className="wa-base-devices-item-meta">
                            Pair: {formatDateTime(device.pairedAt)} | Online: {formatDateTime(device.lastSeenAt)}
                          </p>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="wa-base-playlists" aria-label="Audit logs" style={studioSection === 'logs' ? undefined : { display: 'none' }}>
              <div className="wa-base-playlists-head">
                <h2 className="wa-base-playlists-title">Loguri</h2>
                <button
                  type="button"
                  className="wa-btn"
                  onClick={() =>
                    void loadAuditLogs(undefined, {
                      section: auditSection,
                      outcome: auditSection === 'internal' ? 'error' : auditOutcome
                    })
                  }
                  disabled={auditBusy}
                >
                  {auditBusy ? 'Обновление...' : 'Обновить лог'}
                </button>
              </div>
              <p className="wa-base-playlists-text">
                Loguri detaliate pentru fiecare actiune: inregistrare, playlisturi si loguri interne.
              </p>

              <div className="wa-playlists-submenu" role="tablist" aria-label="Categorie loguri">
                <button
                  type="button"
                  className={auditSection === 'registration' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                  onClick={() => setAuditSection('registration')}
                  disabled={auditBusy}
                >
                  Inregistrare
                </button>
                <button
                  type="button"
                  className={auditSection === 'playlists' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                  onClick={() => setAuditSection('playlists')}
                  disabled={auditBusy}
                >
                  Playlists
                </button>
                <button
                  type="button"
                  className={auditSection === 'internal' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                  onClick={() => setAuditSection('internal')}
                  disabled={auditBusy}
                >
                  Interne
                </button>
              </div>

              {auditSection !== 'internal' ? (
                <div className="wa-playlists-submenu" role="tablist" aria-label="Rezultat loguri">
                  <button
                    type="button"
                    className={auditOutcome === 'success' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                    onClick={() => setAuditOutcome('success')}
                    disabled={auditBusy}
                  >
                    Succes
                  </button>
                  <button
                    type="button"
                    className={auditOutcome === 'error' ? 'wa-playlists-submenu-item is-active' : 'wa-playlists-submenu-item'}
                    onClick={() => setAuditOutcome('error')}
                    disabled={auditBusy}
                  >
                    Erori
                  </button>
                </div>
              ) : (
                <p className="wa-base-playlists-meta">Logurile interne afiseaza problemele (erori) din module precum admin/epg/logo/system.</p>
              )}

              {auditLogs.length === 0 ? (
                <p className="wa-empty">{auditBusy ? 'Se incarca logurile...' : 'Nu exista loguri disponibile.'}</p>
              ) : (
                <div className="wa-base-playlists-custom-list">
                  {auditLogs.map((row) => (
                    <article key={row.id} className="wa-base-playlists-custom-item">
                      <p className="wa-base-playlists-custom-item-name">{row.action}</p>
                      <p className="wa-base-playlists-meta">Data/Ora: {formatDateTime(row.createdAt)}</p>
                      <p className="wa-base-playlists-meta">
                        Actor: {row.userEmail || row.userId || 'system'}
                      </p>
                      <p className="wa-base-playlists-meta">
                        {row.method || '-'} {row.path || '-'} | status: {row.statusCode ?? '-'} |{' '}
                        {row.success ? 'success' : 'error'}
                      </p>
                      {auditSection === 'internal' ? (
                        <p className="wa-audit-problem">
                          Problema: {getAuditIssueDescription(row.details, row.action)}
                        </p>
                      ) : null}
                      {row.entityType || row.entityId ? (
                        <p className="wa-base-playlists-meta">
                          Entitate: {row.entityType || '-'} {row.entityId ? `(${row.entityId})` : ''}
                        </p>
                      ) : null}
                      <pre className="wa-audit-details">{formatAuditDetails(row.details)}</pre>
                    </article>
                  ))}
                </div>
              )}
            </section>
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

            <div className="wa-meta" onMouseEnter={() => setFocusTopic('session')}>
              <span className="wa-meta-label">JWT токен</span>
              <strong className="wa-meta-value">{tokenStorageLabel}</strong>
            </div>
          </aside>
        </div>
        </div>
      </div>
    </div>
  );
};



