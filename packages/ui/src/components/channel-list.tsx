import React from 'react';
import type { Channel } from '@iptv/core';

interface ChannelListProps {
  channels: Channel[];
  selectedChannelId?: string;
  favorites: Set<string>;
  collapsedGroups: Set<string>;
  onSelect: (channel: Channel) => void;
  onToggleGroup: (groupName: string) => void;
  onToggleFavorite: (channel: Channel) => void;
}

const groupChannels = (channels: Channel[]): Map<string, Channel[]> => {
  const grouped = new Map<string, Channel[]>();

  for (const channel of channels) {
    const group = channel.group ?? 'Other';
    const existing = grouped.get(group) ?? [];
    existing.push(channel);
    grouped.set(group, existing);
  }

  return grouped;
};

export const ChannelList: React.FC<ChannelListProps> = ({
  channels,
  selectedChannelId,
  favorites,
  collapsedGroups,
  onSelect,
  onToggleGroup,
  onToggleFavorite
}) => {
  const grouped = groupChannels(channels);

  return (
    <div className="channel-list" role="listbox" aria-label="Channels">
      {[...grouped.entries()].map(([group, groupChannelsList]) => {
        const collapsed = collapsedGroups.has(group);
        return (
          <section key={group} className="channel-group">
            <button className="channel-group__header" onClick={() => onToggleGroup(group)}>
              <span>
                {collapsed ? '+' : '-'} {group}
              </span>
              <small>{groupChannelsList.length}</small>
            </button>
            {!collapsed && (
              <ul>
                {groupChannelsList.map((channel) => {
                  const selected = channel.id === selectedChannelId;
                  const favorite = favorites.has(channel.id);

                  return (
                    <li key={channel.id}>
                      <button
                        className={`channel-item ${selected ? 'channel-item--selected' : ''}`}
                        onClick={() => onSelect(channel)}
                      >
                        <span className="channel-item__name">{channel.name}</span>
                        <span className="channel-item__meta">{favorite ? '?' : '?'}</span>
                      </button>
                      <button
                        className="channel-item__favorite-toggle"
                        onClick={() => onToggleFavorite(channel)}
                        aria-label={`Toggle favorite ${channel.name}`}
                      >
                        {favorite ? 'Unfavorite' : 'Favorite'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
};
