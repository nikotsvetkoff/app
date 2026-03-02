import type { Channel } from '../models/channel';
import { stableHash } from './hash.js';
import { parseExtInfAttributes } from './attributes.js';

interface PendingExtInf {
  name: string;
  attrs: Record<string, string>;
}

const EXTINF_PREFIX = '#EXTINF:';
const EXTGRP_PREFIX = '#EXTGRP:';

const canonicalName = (attrs: Record<string, string>, fallback: string): string => {
  const byAttr = attrs['tvg-name'];
  if (byAttr && byAttr.trim()) {
    return byAttr.trim();
  }
  return fallback.trim() || 'Unnamed Channel';
};

export const buildChannelId = (tvgId: string | undefined, name: string, url: string): string => {
  return stableHash(`${tvgId ?? ''}|${name.trim()}|${url.trim()}`);
};

export const parseM3u = (content: string): Channel[] => {
  const channels: Channel[] = [];
  const lines = content.split(/\r?\n/);
  let pendingExtInf: PendingExtInf | undefined;
  let pendingExtGrp: string | undefined;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith(EXTINF_PREFIX)) {
      const commaIndex = line.indexOf(',');
      const metadata = commaIndex >= 0 ? line.slice(EXTINF_PREFIX.length, commaIndex).trim() : '';
      const name = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : '';
      pendingExtInf = {
        name,
        attrs: parseExtInfAttributes(metadata)
      };
      pendingExtGrp = undefined;
      continue;
    }

    if (line.startsWith(EXTGRP_PREFIX)) {
      const groupName = line.slice(EXTGRP_PREFIX.length).trim();
      pendingExtGrp = groupName || undefined;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const attrs = pendingExtInf?.attrs ?? {};
    const name = canonicalName(attrs, pendingExtInf?.name ?? line);
    const tvgId = attrs['tvg-id']?.trim() || undefined;
    const groupFromExtGrp = pendingExtGrp?.trim() || undefined;
    const groupFromAttr = attrs['group-title']?.trim() || undefined;
    const group = groupFromExtGrp || groupFromAttr;

    channels.push({
      id: buildChannelId(tvgId, name, line),
      name,
      logo: attrs['tvg-logo']?.trim() || undefined,
      group,
      tvgId,
      url: line
    });

    pendingExtInf = undefined;
    pendingExtGrp = undefined;
  }

  return channels;
};
