import { BadRequestException } from '@nestjs/common';
import type { EpgProgram } from '@iptv/core';
import sax from 'sax';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';

interface XmlProgramme {
  channel: string;
  start: string;
  end: string;
  title?: string;
  description?: string;
  rating?: string;
}

const toIso = (raw: string): string => {
  const value = raw.trim();
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);

  if (!matched) {
    const fallback = new Date(value);
    if (Number.isNaN(fallback.getTime())) {
      throw new BadRequestException(`Некорректная дата/время XMLTV: ${raw}`);
    }
    return fallback.toISOString();
  }

  const [, y, m, d, hh, mm, ss, tzRaw] = matched;
  const tz = tzRaw ? `${tzRaw.slice(0, 3)}:${tzRaw.slice(3)}` : 'Z';
  const isoInput = `${y}-${m}-${d}T${hh}:${mm}:${ss}${tz}`;
  const parsed = new Date(isoInput);

  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Некорректная дата/время XMLTV: ${raw}`);
  }

  return parsed.toISOString();
};

const nodeStreamFromResponse = (response: Response): Readable => {
  if (!response.body) {
    throw new BadRequestException('Ответ EPG пустой');
  }
  return Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
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
