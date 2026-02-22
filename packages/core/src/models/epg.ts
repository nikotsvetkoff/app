export interface EpgProgram {
  channelTvgId: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  rating?: string;
}

export interface NowNext {
  channelTvgId: string;
  now?: EpgProgram;
  next?: EpgProgram;
}
