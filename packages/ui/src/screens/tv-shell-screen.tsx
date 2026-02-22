import React from 'react';
import type { Channel, NowNext } from '@iptv/core';
import { TvLayout } from '../components/tv-layout';

interface TvShellScreenProps {
  channels: Channel[];
  selectedChannel?: Channel;
  favorites: Set<string>;
  collapsedGroups: Set<string>;
  nowNextByTvgId: Map<string, NowNext>;
  searchValue: string;
  playerSlot: React.ReactNode;
  onSearchChange: (value: string) => void;
  onSelectChannel: (channel: Channel) => void;
  onToggleGroup: (groupName: string) => void;
  onToggleFavorite: (channel: Channel) => void;
}

export const TvShellScreen: React.FC<TvShellScreenProps> = (props) => {
  return <TvLayout {...props} />;
};
