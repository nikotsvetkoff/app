import type { FavoritesHistoryStorage, KeyValueStore } from './interfaces.js';
import type { PlaybackHistoryItem, PlaybackState } from '../models/playback';

const FAVORITES_KEY = 'iptv:favorites';
const HISTORY_KEY = 'iptv:history';
const PLAYBACK_KEY = 'iptv:playback';

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class BrowserStorageAdapter implements KeyValueStore {
  private readonly fallback = new Map<string, string>();

  get(key: string): string | null {
    try {
      if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
        return globalThis.localStorage.getItem(key);
      }
    } catch {
      // ignore and fallback
    }

    return this.fallback.get(key) ?? null;
  }

  set(key: string, value: string): void {
    try {
      if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
        globalThis.localStorage.setItem(key, value);
        return;
      }
    } catch {
      // ignore and fallback
    }

    this.fallback.set(key, value);
  }
}

export class WebFavoritesHistoryStorage implements FavoritesHistoryStorage {
  constructor(private readonly store: KeyValueStore = new BrowserStorageAdapter()) {}

  getFavorites(): string[] {
    return parseJson<string[]>(this.store.get(FAVORITES_KEY), []);
  }

  setFavorites(channelIds: string[]): void {
    this.store.set(FAVORITES_KEY, JSON.stringify(Array.from(new Set(channelIds))));
  }

  toggleFavorite(channelId: string): string[] {
    const favorites = this.getFavorites();
    const nextFavorites = favorites.includes(channelId)
      ? favorites.filter((item) => item !== channelId)
      : [...favorites, channelId];

    this.setFavorites(nextFavorites);
    return nextFavorites;
  }

  getHistory(): PlaybackHistoryItem[] {
    return parseJson<PlaybackHistoryItem[]>(this.store.get(HISTORY_KEY), []);
  }

  pushHistory(item: PlaybackHistoryItem): PlaybackHistoryItem[] {
    const existing = this.getHistory().filter((entry) => entry.channelId !== item.channelId);
    const next = [item, ...existing].slice(0, 50);
    this.store.set(HISTORY_KEY, JSON.stringify(next));
    return next;
  }

  getPlaybackState(): PlaybackState | undefined {
    return parseJson<PlaybackState | undefined>(this.store.get(PLAYBACK_KEY), undefined);
  }

  setPlaybackState(state: PlaybackState): void {
    this.store.set(PLAYBACK_KEY, JSON.stringify(state));
  }
}
