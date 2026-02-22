import type { PlayerAdapter, PlayerLoadOptions } from '@iptv/core';
import { PlayerEventEmitter } from '@iptv/core';

export class AvPlayAdapter implements PlayerAdapter {
  private emitter = new PlayerEventEmitter();
  private container?: HTMLElement;

  async init(container: HTMLElement): Promise<void> {
    this.container = container;
    if (!window.webapis?.avplay) {
      throw new Error('AVPlay API unavailable. Run on Samsung Tizen device/emulator.');
    }

    const bounds = container.getBoundingClientRect();
    window.webapis.avplay.setDisplayRect(bounds.x, bounds.y, bounds.width, bounds.height);
    window.webapis.avplay.setBufferingParam(
      'PLAYER_BUFFER_FOR_PLAY',
      'PLAYER_BUFFER_SIZE_IN_SECOND',
      '3'
    );
    window.webapis.avplay.setBufferingParam(
      'PLAYER_BUFFER_FOR_RESUME',
      'PLAYER_BUFFER_SIZE_IN_SECOND',
      '2'
    );
    window.webapis.avplay.setListener({
      onbufferingstart: () => this.emitter.emit('state', { state: 'buffering_start' }),
      onbufferingprogress: (percent) => this.emitter.emit('state', { state: 'buffering', percent }),
      onbufferingcomplete: () => this.emitter.emit('state', { state: 'buffering_complete' }),
      oncurrentplaytime: (ms) => this.emitter.emit('time', ms / 1000),
      onstreamcompleted: () => this.emitter.emit('ended'),
      onerror: (error) => this.emitter.emit('error', error),
      onerrormsg: (_, message) => this.emitter.emit('error', new Error(message))
    });
  }

  async load(url: string, opts?: PlayerLoadOptions): Promise<void> {
    if (!window.webapis?.avplay) {
      throw new Error('AVPlay API unavailable');
    }

    window.webapis.avplay.stop();
    window.webapis.avplay.close();
    window.webapis.avplay.open(url);

    await new Promise<void>((resolve, reject) => {
      window.webapis?.avplay.prepareAsync(
        () => {
          if (opts?.startAtSec && opts.startAtSec > 0) {
            window.webapis?.avplay.seekTo(Math.floor(opts.startAtSec * 1000));
          }
          this.emitter.emit('state', { state: 'ready' });
          resolve();
        },
        (error) => reject(error)
      );
    });

    if (this.container) {
      this.syncDisplayRect();
    }
  }

  syncDisplayRect(): void {
    if (!window.webapis?.avplay || !this.container) {
      return;
    }

    const bounds = this.container.getBoundingClientRect();
    window.webapis.avplay.setDisplayRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  play(): void {
    window.webapis?.avplay.play();
  }

  pause(): void {
    window.webapis?.avplay.pause();
  }

  stop(): void {
    window.webapis?.avplay.stop();
  }

  seekTo(sec: number): void {
    window.webapis?.avplay.seekTo(Math.floor(sec * 1000));
  }

  setVolume(): void {
    // AVPlay volume is usually managed by system TV controls.
  }

  destroy(): void {
    try {
      window.webapis?.avplay.stop();
      window.webapis?.avplay.close();
    } catch {
      // no-op
    }
  }

  on(event: 'state' | 'time' | 'ended' | 'error', cb: (...args: unknown[]) => void): () => void {
    return this.emitter.subscribe(event, cb);
  }
}
