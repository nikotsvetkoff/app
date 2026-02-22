import React from 'react';
import type { Channel, NowNext } from '@iptv/core';

interface NowNextOverlayProps {
  channel?: Channel;
  nowNext?: NowNext;
}

const getProgress = (start?: string, end?: string): number => {
  if (!start || !end) {
    return 0;
  }

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const nowMs = Date.now();

  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return 0;
  }

  return Math.max(0, Math.min(1, (nowMs - startMs) / (endMs - startMs)));
};

export const NowNextOverlay: React.FC<NowNextOverlayProps> = ({ channel, nowNext }) => {
  const progress = getProgress(nowNext?.now?.start, nowNext?.now?.end);

  return (
    <div className="now-next-overlay" aria-live="polite">
      <strong>{channel?.name ?? 'No channel selected'}</strong>
      <div className="now-next-overlay__row">
        <span>Now: {nowNext?.now?.title ?? 'N/A'}</span>
      </div>
      <div className="now-next-overlay__row">
        <span>Next: {nowNext?.next?.title ?? 'N/A'}</span>
      </div>
      <div className="now-next-overlay__progress">
        <span style={{ width: `${Math.floor(progress * 100)}%` }} />
      </div>
    </div>
  );
};
