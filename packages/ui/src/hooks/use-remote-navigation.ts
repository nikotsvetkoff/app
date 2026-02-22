import { useEffect } from 'react';
import type { RemoteAction } from '@iptv/core';

interface UseRemoteNavigationArgs {
  mapper: (event: KeyboardEvent) => RemoteAction;
  onAction: (action: RemoteAction) => void;
}

export const useRemoteNavigation = ({ mapper, onAction }: UseRemoteNavigationArgs): void => {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const action = mapper(event);
      if (action === 'NONE') {
        return;
      }
      event.preventDefault();
      onAction(action);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mapper, onAction]);
};
