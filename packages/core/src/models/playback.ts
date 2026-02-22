export interface PlaybackState {
  currentChannelId?: string;
  positionSeconds: number;
  lastUpdatedAt: string;
}

export interface PlaybackHistoryItem {
  channelId: string;
  playedAt: string;
  positionSeconds: number;
}
