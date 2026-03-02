import { BadRequestException } from '@nestjs/common';
import type { EpgProgram } from '@iptv/core';
import sax from 'sax';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { createGunzip } from 'zlib';

interface XmlProgramme {
  channel: string;
  start: string;
  end: string;
  title?: string;
  description?: string;
  rating?: string;
}

interface XmlProgramState {
  program: EpgProgram;
  startMs: number;
  endMs: number;
}

interface XmlNowNextState {
  now?: XmlProgramState;
  next?: XmlProgramState;
}

export interface XmlTvNowNextSnapshot {
  generatedAt: string;
  nowNextByTvgId: Record<string, { now?: EpgProgram; next?: EpgProgram }>;
  logosByTvgId: Record<string, string>;
}

interface ParseXmlTvNowNextOptions {
  nowDate?: Date;
  assumeGzip?: boolean;
}

const normalizeTvgId = (raw: string): string => raw.trim().toLowerCase();

const toIso = (raw: string): string => {
  const value = raw.trim();
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);

  if (!matched) {
    const fallback = new Date(value);
    if (Number.isNaN(fallback.getTime())) {
      throw new BadRequestException(`Invalid XMLTV date/time: ${raw}`);
    }
    return fallback.toISOString();
  }

  const [, y, m, d, hh, mm, ss, tzRaw] = matched;
  const tz = tzRaw ? `${tzRaw.slice(0, 3)}:${tzRaw.slice(3)}` : 'Z';
  const isoInput = `${y}-${m}-${d}T${hh}:${mm}:${ss}${tz}`;
  const parsed = new Date(isoInput);

  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid XMLTV date/time: ${raw}`);
  }

  return parsed.toISOString();
};

const nodeStreamFromResponse = (response: Response): Readable => {
  if (!response.body) {
    throw new BadRequestException('Empty EPG response body');
  }
  return Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
};

const toIsoSafe = (raw: string): { iso: string; ms: number } | null => {
  try {
    const iso = toIso(raw);
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      return null;
    }
    return { iso, ms };
  } catch {
    return null;
  }
};

const createXmlInputStream = (response: Response, assumeGzip = false): Readable => {
  const source = nodeStreamFromResponse(response);
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const contentEncoding = (response.headers.get('content-encoding') ?? '').toLowerCase();
  const responseUrl = (response.url ?? '').toLowerCase();
  const shouldGunzip =
    assumeGzip ||
    responseUrl.endsWith('.gz') ||
    contentType.includes('gzip') ||
    contentEncoding.includes('gzip');

  return shouldGunzip ? source.pipe(createGunzip()) : source;
};

export const parseXmlTvPrograms = async (response: Response): Promise<EpgProgram[]> => {
  const programs: EpgProgram[] = [];

  await new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, {
      lowercase: true,
      trim: true,
      normalize: true
    });

    let current: XmlProgramme | undefined;
    let currentTag: string | undefined;
    let textBuffer = '';

    parser.on('opentag', (node) => {
      const nodeName = String(node.name).toLowerCase();

      if (nodeName === 'programme') {
        current = {
          channel: String(node.attributes.channel ?? ''),
          start: String(node.attributes.start ?? ''),
          end: String(node.attributes.stop ?? '')
        };
      }

      if (current) {
        currentTag = nodeName;
        textBuffer = '';
      }
    });

    parser.on('text', (text: string) => {
      if (current && currentTag) {
        textBuffer += text;
      }
    });

    parser.on('cdata', (text: string) => {
      if (current && currentTag) {
        textBuffer += text;
      }
    });

    parser.on('closetag', (tagName: string) => {
      const nodeName = tagName.toLowerCase();
      if (!current) {
        return;
      }

      if (nodeName === 'title' && textBuffer) {
        current.title = textBuffer;
      }

      if (nodeName === 'desc' && textBuffer) {
        current.description = textBuffer;
      }

      if (nodeName === 'value' && textBuffer) {
        current.rating = textBuffer;
      }

      if (nodeName === 'programme') {
        if (current.channel && current.title && current.start && current.end) {
          programs.push({
            channelTvgId: current.channel,
            title: current.title,
            start: toIso(current.start),
            end: toIso(current.end),
            description: current.description,
            rating: current.rating
          });
        }
        current = undefined;
      }

      textBuffer = '';
      currentTag = undefined;
    });

    parser.on('error', (error) => reject(error));
    parser.on('end', () => resolve());

    nodeStreamFromResponse(response).pipe(parser);
  });

  return programs;
};

export const parseXmlTvNowNextSnapshot = async (
  response: Response,
  options: ParseXmlTvNowNextOptions = {}
): Promise<XmlTvNowNextSnapshot> => {
  const nowDate = options.nowDate ?? new Date();
  const nowMs = nowDate.getTime();
  const nowNextByTvgId = new Map<string, XmlNowNextState>();
  const logosByTvgId = new Map<string, string>();

  await new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, {
      lowercase: true,
      trim: true,
      normalize: true
    });

    let currentProgramme: XmlProgramme | undefined;
    let currentChannelId: string | undefined;
    let currentTag: string | undefined;
    let textBuffer = '';

    const applyNowNext = (programme: XmlProgramme): void => {
      const tvgId = normalizeTvgId(programme.channel);
      if (!tvgId || !programme.title) {
        return;
      }

      const parsedStart = toIsoSafe(programme.start);
      const parsedEnd = toIsoSafe(programme.end);
      if (!parsedStart || !parsedEnd || parsedEnd.ms <= parsedStart.ms) {
        return;
      }

      const program: EpgProgram = {
        channelTvgId: tvgId,
        title: programme.title,
        start: parsedStart.iso,
        end: parsedEnd.iso,
        description: programme.description,
        rating: programme.rating
      };

      const current = nowNextByTvgId.get(tvgId) ?? {};

      if (parsedStart.ms <= nowMs && parsedEnd.ms > nowMs) {
        const existingNow = current.now;
        if (!existingNow || parsedStart.ms >= existingNow.startMs) {
          current.now = {
            program,
            startMs: parsedStart.ms,
            endMs: parsedEnd.ms
          };
        }
        nowNextByTvgId.set(tvgId, current);
        return;
      }

      if (parsedStart.ms > nowMs) {
        const existingNext = current.next;
        if (!existingNext || parsedStart.ms < existingNext.startMs) {
          current.next = {
            program,
            startMs: parsedStart.ms,
            endMs: parsedEnd.ms
          };
        }
        nowNextByTvgId.set(tvgId, current);
      }
    };

    parser.on('opentag', (node) => {
      const nodeName = String(node.name).toLowerCase();

      if (nodeName === 'channel') {
        const channelId = normalizeTvgId(String(node.attributes.id ?? ''));
        currentChannelId = channelId || undefined;
      }

      if (nodeName === 'programme') {
        currentProgramme = {
          channel: normalizeTvgId(String(node.attributes.channel ?? '')),
          start: String(node.attributes.start ?? ''),
          end: String(node.attributes.stop ?? '')
        };
      }

      if (nodeName === 'icon' && currentChannelId) {
        const iconSrc = String(node.attributes.src ?? '').trim();
        if (iconSrc && !logosByTvgId.has(currentChannelId)) {
          logosByTvgId.set(currentChannelId, iconSrc);
        }
      }

      currentTag = nodeName;
      textBuffer = '';
    });

    parser.on('text', (text: string) => {
      if (currentTag) {
        textBuffer += text;
      }
    });

    parser.on('cdata', (text: string) => {
      if (currentTag) {
        textBuffer += text;
      }
    });

    parser.on('closetag', (tagName: string) => {
      const nodeName = tagName.toLowerCase();
      const value = textBuffer.trim();

      if (currentProgramme) {
        if (nodeName === 'title' && value) {
          currentProgramme.title = value;
        } else if (nodeName === 'desc' && value) {
          currentProgramme.description = value;
        } else if (nodeName === 'value' && value) {
          currentProgramme.rating = value;
        } else if (nodeName === 'programme') {
          applyNowNext(currentProgramme);
          currentProgramme = undefined;
        }
      } else if (nodeName === 'channel') {
        currentChannelId = undefined;
      }

      textBuffer = '';
      currentTag = undefined;
    });

    parser.on('error', (error) => reject(error));
    parser.on('end', () => resolve());

    const input = createXmlInputStream(response, options.assumeGzip);
    input.on('error', (error) => reject(error));
    input.pipe(parser);
  });

  const nowNextJson: Record<string, { now?: EpgProgram; next?: EpgProgram }> = {};
  for (const [tvgId, state] of nowNextByTvgId.entries()) {
    nowNextJson[tvgId] = {
      now: state.now?.program,
      next: state.next?.program
    };
  }

  const logosJson: Record<string, string> = {};
  for (const [tvgId, logoUrl] of logosByTvgId.entries()) {
    logosJson[tvgId] = logoUrl;
  }

  return {
    generatedAt: nowDate.toISOString(),
    nowNextByTvgId: nowNextJson,
    logosByTvgId: logosJson
  };
};
