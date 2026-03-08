import type { PlayerAdapter, PlayerLoadOptions } from '@iptv/core';
import { PlayerEventEmitter } from '@iptv/core';

const DISPLAY_SYNC_DELAYS_MS = [0, 120, 450, 1100];

export class AvPlayAdapter implements PlayerAdapter {
  private emitter = new PlayerEventEmitter();
  private container?: HTMLElement;

  private setDisplayMode(): void {
    const avplay = window.webapis?.avplay;
    if (!avplay || typeof avplay.setDisplayMethod !== 'function') {
      return;
    }

    const modes: Array<
      'PLAYER_DISPLAY_MODE_FULL_SCREEN' | 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO' | 'PLAYER_DISPLAY_MODE_LETTER_BOX'
    > = ['PLAYER_DISPLAY_MODE_FULL_SCREEN', 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO', 'PLAYER_DISPLAY_MODE_LETTER_BOX'];

    for (const mode of modes) {
      try {
        avplay.setDisplayMethod(mode);
        return;
      } catch {
        // ignore unsupported display mode on current firmware
      }
    }
  }

  private resolveDisplayRect(): { x: number; y: number; width: number; height: number } {
    const screenWidth = Number(screen?.width);
    const screenHeight = Number(screen?.height);
    const hasScreenSize = Number.isFinite(screenWidth) && Number.isFinite(screenHeight) && screenWidth > 0 && screenHeight > 0;
    const viewportWidth = Math.max(
      1,
      Math.floor((hasScreenSize ? screenWidth : undefined) || window.innerWidth || document.documentElement?.clientWidth || 1920)
    );
    const viewportHeight = Math.max(
      1,
      Math.floor(
        (hasScreenSize ? screenHeight : undefined) || window.innerHeight || document.documentElement?.clientHeight || 1080
      )
    );
    return {
      x: 0,
      y: 0,
      width: viewportWidth,
      height: viewportHeight
    };
  }

  private syncDisplayRectBurst(): void {
    for (const delay of DISPLAY_SYNC_DELAYS_MS) {
      if (delay === 0) {
        this.syncDisplayRect();
        continue;
      }
      window.setTimeout(() => this.syncDisplayRect(), delay);
    }
  }

  private applyStreamingHints(): void {
    const avplay = window.webapis?.avplay;
    if (!avplay || typeof avplay.setStreamingProperty !== 'function') {
      return;
    }

    const hints = [
      'STARTBITRATE=HIGHEST',
      'FIXED_MAX_RESOLUTION=1920X1080',
      'STARTBITRATE=HIGHEST|FIXED_MAX_RESOLUTION=1920X1080'
    ];

    for (const hint of hints) {
      try {
        avplay.setStreamingProperty('ADAPTIVE_INFO', hint);
      } catch {
        // ignore unsupported adaptive hint values
      }
    }
  }

  private ensureVideoTrackSelected(): void {
    const avplay = window.webapis?.avplay;
    if (!avplay || typeof avplay.getTotalTrackInfo !== 'function' || typeof avplay.setSelectTrack !== 'function') {
      return;
    }

    try {
      const tracks = avplay.getTotalTrackInfo();
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return;
      }

      const videoTrack = tracks.find((track) => String(track?.type ?? '').toUpperCase() === 'VIDEO');
      if (!videoTrack) {
        return;
      }

      const rawIndexCandidates = [videoTrack.index, videoTrack.track_num];
      const trackIndex = rawIndexCandidates.find((value) => Number.isFinite(value as number));
      if (typeof trackIndex !== 'number') {
        return;
      }

      avplay.setSelectTrack('VIDEO', Math.floor(trackIndex));
    } catch {
      // ignore track-selection errors on firmware variants
    }
  }

  async init(container: HTMLElement): Promise<void> {
    this.container = container;
    if (!window.webapis?.avplay) {
      throw new Error('AVPlay API unavailable. Run on Samsung Tizen device/emulator.');
    }

    this.setDisplayMode();
    this.syncDisplayRectBurst();
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
    const streamUrl = (url ?? '').trim();
    if (!streamUrl) {
      throw new Error('Stream URL missing');
    }

    try {
      window.webapis.avplay.stop();
    } catch {
      // ignore state transition errors
    }
    try {
      window.webapis.avplay.close();
    } catch {
      // ignore state transition errors
    }
    window.webapis.avplay.open(streamUrl);
    this.applyStreamingHints();

    await new Promise<void>((resolve, reject) => {
      window.webapis?.avplay.prepareAsync(
        () => {
          this.ensureVideoTrackSelected();
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
      this.syncDisplayRectBurst();
    }
  }

  syncDisplayRect(): void {
    if (!window.webapis?.avplay) {
      return;
    }
    this.setDisplayMode();
    const rect = this.resolveDisplayRect();

    try {
      window.webapis.avplay.setDisplayRect(rect.x, rect.y, rect.width, rect.height);
    } catch {
      // ignore setDisplayRect errors on unsupported sizes/states
    }
  }

  play(): void {
    this.syncDisplayRectBurst();
    window.webapis?.avplay.play();
    this.syncDisplayRectBurst();
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
