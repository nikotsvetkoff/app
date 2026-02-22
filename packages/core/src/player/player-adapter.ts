export type PlayerEvent = 'state' | 'time' | 'ended' | 'error';

export interface PlayerLoadOptions {
  startAtSec?: number;
  headers?: Record<string, string>;
}

export interface PlayerAdapter {
  init(container: unknown): Promise<void>;
  load(url: string, opts?: PlayerLoadOptions): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(sec: number): void;
  setVolume(v: number): void;
  destroy(): void;
  on(event: PlayerEvent, cb: (...args: unknown[]) => void): () => void;
}

export class PlayerEventEmitter {
  private handlers = new Map<PlayerEvent, Set<(...args: unknown[]) => void>>();

  emit(event: PlayerEvent, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  subscribe(event: PlayerEvent, handler: (...args: unknown[]) => void): () => void {
    const existing = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    existing.add(handler);
    this.handlers.set(event, existing);

    return () => {
      existing.delete(handler);
      if (!existing.size) {
        this.handlers.delete(event);
      }
    };
  }
}
