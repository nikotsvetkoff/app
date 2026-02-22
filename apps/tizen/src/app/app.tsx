import type { Channel, RemoteAction } from '@iptv/core';
import { mapTizenKeyCode, mapWebKey } from '@iptv/core';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AvPlayAdapter } from '../platform/player-avplay';

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

type ScreenView = 'menu' | 'pairing' | 'token' | 'player';

const DEVICE_TOKEN_KEY = 'iptv:tizen:deviceToken';
const API_BASE_KEY = 'iptv:tizen:apiBase';
const LAN_FALLBACK_API_BASE = import.meta.env.VITE_API_BASE_FALLBACK_URL ?? 'http://10.0.0.246:3000';
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? LAN_FALLBACK_API_BASE;
const OVERRIDE_WEB_ADMIN_BASE = import.meta.env.VITE_WEB_ADMIN_URL;
const REQUEST_TIMEOUT_MS = 9000;
const TOKEN_ITEM_COUNT = 3;
const LIST_VISIBLE_COUNT = 10;

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const normalizeGroupName = (value?: string): string => {
  const normalized = (value ?? '').trim();
  return normalized || 'Fara categorie';
};

const getChannelGroupName = (channel: Channel): string =>
  normalizeGroupName((channel as Channel & { groupName?: string }).groupName ?? channel.group);

const wrapIndex = (next: number, length: number): number => {
  if (length <= 0) {
    return 0;
  }

  return (next % length + length) % length;
};

const getRemoteAction = (event: KeyboardEvent): RemoteAction => {
  const tizenAction = mapTizenKeyCode(event.keyCode);
  if (tizenAction !== 'NONE') {
    return tizenAction;
  }
  return mapWebKey(event.key);
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

  // Tizen app runs on TV, so localhost usually points to TV itself, not backend PC.
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

export const TizenApp: React.FC = () => {
  const [apiBase, setApiBase] = useState<string>(() => getInitialApiBase());
  const [apiBaseInput, setApiBaseInput] = useState<string>(() => getInitialApiBase());
  const [view, setView] = useState<ScreenView>('menu');
  const [statusMessage, setStatusMessage] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [tokenInput, setTokenInput] = useState('');

  const [menuIndex, setMenuIndex] = useState(0);
  const [tokenIndex, setTokenIndex] = useState(0);

  const [pairCode, setPairCode] = useState<string>();
  const [pairingUrl, setPairingUrl] = useState<string>();
  const pairPollingRef = useRef<number>();

  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedCategoryIndex, setSelectedCategoryIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [playingChannelId, setPlayingChannelId] = useState<string>();
  const [showChannelList, setShowChannelList] = useState(true);

  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef(new AvPlayAdapter());
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

    const start = Math.max(0, selectedIndex - (LIST_VISIBLE_COUNT - 1));
    const end = Math.min(categoryChannels.length, start + LIST_VISIBLE_COUNT);
    return { start, end };
  }, [categoryChannels, selectedIndex]);

  const visibleChannels = useMemo(
    () => categoryChannels.slice(visibleWindow.start, visibleWindow.end),
    [categoryChannels, visibleWindow.end, visibleWindow.start]
  );

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
          setPlayingChannelId(channel.id);
        }
        return next;
      });
    },
    [categoryChannels]
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
        deviceName: 'Samsung Tizen TV',
        platform: 'tizen'
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
    setMenuIndex(0);
    setView('menu');
    setStatusMessage('Disconnected from device token.');
  }, [clearPairPolling]);

  const playChannel = useCallback(async (channel: Channel) => {
    try {
      await playerRef.current.load(channel.url);
      playerRef.current.play();
      setErrorMessage(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'stream unsupported';
      setErrorMessage(message);
    }
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    const playerContainer = playerContainerRef.current;
    if (!playerContainer) {
      return;
    }

    let mounted = true;
    player
      .init(playerContainer)
      .then(() => {
        if (!mounted) {
          return;
        }
        player.syncDisplayRect();
      })
      .catch((initError: unknown) => {
        const message =
          initError instanceof Error ? initError.message : 'player initialization failed';
        setErrorMessage(message);
      });

    const unsubscribeError = player.on('error', (playerError) => {
      const message = playerError instanceof Error ? playerError.message : 'stream unsupported';
      setErrorMessage(message);
    });

    return () => {
      mounted = false;
      unsubscribeError();
      player.destroy();
    };
  }, []);

  useEffect(() => {
    if (view !== 'player') {
      return;
    }

    playerRef.current.syncDisplayRect();

    const onResize = () => {
      playerRef.current.syncDisplayRect();
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [showChannelList, view]);

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
    if (view !== 'player' || !playingChannel) {
      return;
    }

    playChannel(playingChannel).catch(() => {
      // handled in playChannel
    });
  }, [playChannel, playingChannel, view]);

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
            const currentPlayingChannel = channels.find((channel) => channel.id === playingChannelId);
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

          if (selectedChannel) {
            setPlayingChannelId(selectedChannel.id);
            setShowChannelList(false);
            playerRef.current.syncDisplayRect();
          }
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
    clearPairPolling,
    connectWithToken,
    logoutDevice,
    menuIndex,
    playingChannelId,
    saveApiBase,
    selectedChannel,
    showChannelList,
    startPairing,
    stepChannelAndPlay,
    tokenIndex,
    view
  ]);

  useEffect(() => {
    return () => {
      clearPairPolling();
    };
  }, [clearPairPolling]);

  const pairingQrImageUrl = pairingUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(pairingUrl)}`
    : undefined;

  if (view !== 'player') {
    return (
      <div className="setup">
        <div className="setup__panel">
          {view === 'menu' ? (
            <>
              <header className="brand-header">
                <div>
                  <p className="brand-logo">AccountTV</p>
                  <h1>IPTV Tizen Dashboard</h1>
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
              <p className="remote-hint">Remote: UP/DOWN select, ENTER confirm, BACK return.</p>

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
        <div ref={playerContainerRef} className="video" />
        <div className="screen__bar">
          <strong>{playingChannel?.name || 'No channel selected'}</strong>
          <span>{showChannelList ? 'ENTER play fullscreen' : 'UP/DOWN change channel, OK menu'}</span>
        </div>
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
                    playerRef.current.syncDisplayRect();
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
