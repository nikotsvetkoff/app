/// <reference types="vite/client" />

declare global {
  interface Window {
    webapis?: {
      avplay: {
        open(url: string): void;
        close(): void;
        prepareAsync(onSuccess: () => void, onError?: (error: unknown) => void): void;
        getState?(): 'NONE' | 'IDLE' | 'READY' | 'PLAYING' | 'PAUSED' | 'UNKNOWN';
        setStreamingProperty?(propertyType: string, value: string): void;
        getTotalTrackInfo?(): Array<{
          type?: string;
          index?: number;
          track_num?: number;
          [key: string]: unknown;
        }>;
        setSelectTrack?(type: 'VIDEO' | 'AUDIO' | 'TEXT', index: number): void;
        setDisplayMethod?(
          mode:
            | 'PLAYER_DISPLAY_MODE_LETTER_BOX'
            | 'PLAYER_DISPLAY_MODE_FULL_SCREEN'
            | 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO'
        ): void;
        play(): void;
        pause(): void;
        stop(): void;
        seekTo(milliseconds: number): void;
        setDisplayRect(x: number, y: number, width: number, height: number): void;
        setBufferingParam(
          mode: 'PLAYER_BUFFER_FOR_PLAY' | 'PLAYER_BUFFER_FOR_RESUME',
          param: 'PLAYER_BUFFER_SIZE_IN_SECOND',
          value: string
        ): void;
        setListener(listener: {
          onbufferingstart?: () => void;
          onbufferingprogress?: (percent: number) => void;
          onbufferingcomplete?: () => void;
          oncurrentplaytime?: (milliseconds: number) => void;
          onstreamcompleted?: () => void;
          onerror?: (error: unknown) => void;
          onerrormsg?: (error: unknown, message: string) => void;
        }): void;
      };
    };
  }
}

export {};
