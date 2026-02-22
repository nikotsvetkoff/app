import type { PlayerAdapter, PlayerLoadOptions } from '@iptv/core';
import { PlayerEventEmitter } from '@iptv/core';

const isLikelyHls = (url: string): boolean => /\.m3u8(\?|$)/i.test(url);

export class Html5PlayerAdapter implements PlayerAdapter {
  private readonly emitter = new PlayerEventEmitter();
  private video?: HTMLVideoElement;

  async init(container: HTMLElement): Promise<void> {
    const video = document.createElement('video');
    video.style.width = '100%';
    video.style.height = '100%';
    video.setAttribute('playsinline', 'true');
    video.autoplay = false;
    video.controls = false;

    video.addEventListener('playing', () => this.emitter.emit('state', { state: 'playing' }));
    video.addEventListener('pause', () => this.emitter.emit('state', { state: 'paused' }));
    video.addEventListener('timeupdate', () => this.emitter.emit('time', video.currentTime));
    video.addEventListener('ended', () => this.emitter.emit('ended'));
    video.addEventListener('error', () =>
      this.emitter.emit('error', new Error('stream unsupported'))
    );

    container.replaceChildren(video);
    this.video = video;
  }

  async load(url: string, opts?: PlayerLoadOptions): Promise<void> {
    if (!this.video) {
      throw new Error('Player not initialized');
    }

    const supportsHls =
      this.video.canPlayType('application/vnd.apple.mpegurl') !== '' ||
      this.video.canPlayType('application/x-mpegURL') !== '';

    if (isLikelyHls(url) && !supportsHls) {
      throw new Error('stream unsupported: hls not supported natively on this device/browser');
    }

    this.video.src = url;
    this.video.load();

    if (opts?.startAtSec && opts.startAtSec > 0) {
      this.video.currentTime = opts.startAtSec;
    }
  }

  play(): void {
    this.video?.play().catch((error) => {
      this.emitter.emit('error', error);
    });
  }

  pause(): void {
    this.video?.pause();
  }

  stop(): void {
    if (!this.video) {
      return;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  seekTo(sec: number): void {
    if (!this.video) {
      return;
    }
    this.video.currentTime = sec;
  }

  setVolume(v: number): void {
    if (!this.video) {
      return;
    }
    this.video.volume = Math.max(0, Math.min(1, v));
  }

  destroy(): void {
    this.stop();
    this.video?.remove();
    this.video = undefined;
  }

  on(event: 'state' | 'time' | 'ended' | 'error', cb: (...args: unknown[]) => void): () => void {
    return this.emitter.subscribe(event, cb);
  }
}
