import React from 'react';
import type { Channel, NowNext } from '@iptv/core';
import { ChannelList } from './channel-list';
import { NowNextOverlay } from './now-next-overlay';
import { SearchBar } from './search-bar';

interface TvLayoutProps {
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

export const TvLayout: React.FC<TvLayoutProps> = ({
  channels,
  selectedChannel,
  favorites,
  collapsedGroups,
  nowNextByTvgId,
  searchValue,
  playerSlot,
  onSearchChange,
  onSelectChannel,
  onToggleGroup,
  onToggleFavorite
}) => {
  const filtered = channels.filter((channel) =>
    channel.name.toLowerCase().includes(searchValue.toLowerCase().trim())
  );

  const nowNext = selectedChannel?.tvgId ? nowNextByTvgId.get(selectedChannel.tvgId) : undefined;

  return (
    <div className="tv-layout">
      <aside className="tv-layout__sidebar">
        <SearchBar value={searchValue} onChange={onSearchChange} />
        <ChannelList
          channels={filtered}
          selectedChannelId={selectedChannel?.id}
          favorites={favorites}
          collapsedGroups={collapsedGroups}
          onSelect={onSelectChannel}
          onToggleGroup={onToggleGroup}
          onToggleFavorite={onToggleFavorite}
        />
      </aside>
      <main className="tv-layout__player">
        <div className="player-slot">{playerSlot}</div>
        <NowNextOverlay channel={selectedChannel} nowNext={nowNext} />
      </main>
    </div>
  );
};
