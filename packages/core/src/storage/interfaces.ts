import type { PlaybackHistoryItem, PlaybackState } from '../models/playback';

export interface FavoritesHistoryStorage {
  getFavorites(): string[];
  setFavorites(channelIds: string[]): void;
  toggleFavorite(channelId: string): string[];

  getHistory(): PlaybackHistoryItem[];
  pushHistory(item: PlaybackHistoryItem): PlaybackHistoryItem[];

  getPlaybackState(): PlaybackState | undefined;
  setPlaybackState(state: PlaybackState): void;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
