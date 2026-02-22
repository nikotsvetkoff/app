import type { RemoteAction } from './focus-manager';

const WEB_KEYMAP: Record<string, RemoteAction> = {
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  Enter: 'ENTER',
  Escape: 'BACK',
  Backspace: 'BACK',
  ContextMenu: 'MENU'
};

const TIZEN_KEYMAP: Record<number, RemoteAction> = {
  38: 'UP',
  40: 'DOWN',
  37: 'LEFT',
  39: 'RIGHT',
  13: 'ENTER',
  10009: 'BACK',
  10182: 'BACK',
  18: 'MENU'
};

const WEBOS_KEYMAP: Record<number, RemoteAction> = {
  38: 'UP',
  40: 'DOWN',
  37: 'LEFT',
  39: 'RIGHT',
  13: 'ENTER',
  461: 'BACK',
  8: 'BACK'
};

export const mapWebKey = (key: string): RemoteAction => WEB_KEYMAP[key] ?? 'NONE';
export const mapTizenKeyCode = (keyCode: number): RemoteAction => TIZEN_KEYMAP[keyCode] ?? 'NONE';
export const mapWebOsKeyCode = (keyCode: number): RemoteAction => WEBOS_KEYMAP[keyCode] ?? 'NONE';
