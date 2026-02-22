const NBSP = /\u00a0/g;
const TAG_RE = /<[^>]+>/g;

const decodeHtmlEntities = (input: string): string => {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => {
      const numeric = Number.parseInt(code, 10);
      return Number.isFinite(numeric) ? String.fromCharCode(numeric) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const numeric = Number.parseInt(code, 16);
      return Number.isFinite(numeric) ? String.fromCharCode(numeric) : '';
    });
};

const collapseWhitespace = (input: string): string => {
  return decodeHtmlEntities(input)
    .replace(NBSP, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const textFromHtml = (input: string): string => {
  return collapseWhitespace(input.replace(TAG_RE, ' '));
};

const extractRows = (html: string): string[] => {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
};

const extractCells = (rowHtml: string): string[] => {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
};

const extractCaptionHtml = (html: string): string | null => {
  const match = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
  return match ? match[1] : null;
};

const extractAttribute = (html: string, attributeName: string): string | null => {
  const escaped = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const doubleQuoted = html.match(new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`, 'i'));
  if (doubleQuoted?.[1] !== undefined) {
    return decodeHtmlEntities(doubleQuoted[1]).trim();
  }
  const singleQuoted = html.match(new RegExp(`${escaped}\\s*=\\s*'([^']*)'`, 'i'));
  if (singleQuoted?.[1] !== undefined) {
    return decodeHtmlEntities(singleQuoted[1]).trim();
  }
  return null;
};

const parseNumber = (raw: string): number => {
  const cleaned = raw.replace(/[^\d]/g, '');
  const value = Number.parseInt(cleaned, 10);
  return Number.isFinite(value) ? value : 0;
};

const toProviderSourcePath = (channelsPath: string): string => {
  const queryPart = channelsPath.split('?')[1] ?? '';
  const params = new URLSearchParams(queryPart);
  return params.get('f')?.trim() ?? '';
};

const slugify = (raw: string): string => {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
};

const buildChannelExternalKey = (
  tvgId: string | null,
  epgPath: string | null,
  displayName: string,
  rowIndex: number
): string => {
  if (tvgId) {
    return `tvg:${tvgId.toLowerCase()}`;
  }
  if (epgPath) {
    return `epg:${epgPath.toLowerCase()}`;
  }
  const slug = slugify(displayName) || 'channel';
  return `name:${slug}:${rowIndex + 1}`;
};

export interface ParsedProviderRow {
  key: string;
  sourcePath: string;
  channelsPath: string;
  updatedLabel: string;
  sizeLabel: string;
  channelsCount: number;
}

export interface ParsedProviderChannelsMetadata {
  providerLabel: string | null;
  updatedLabel: string | null;
  channelsCount: number | null;
}

export interface ParsedChannelRow {
  externalKey: string;
  displayName: string;
  tvgId: string | null;
  logoUrl: string | null;
  epgPath: string | null;
}

export interface ParsedProgramRow {
  sequence: number;
  dateLabel: string;
  timeLabel: string;
  title: string;
  description: string | null;
}

export interface ParsedProgramsMetadata {
  channelLabel: string | null;
  parsedAtLabel: string | null;
  programCount: number | null;
}

export const parseProvidersTable = (html: string): ParsedProviderRow[] => {
  const rows = extractRows(html);
  const providers: ParsedProviderRow[] = [];

  for (const rowHtml of rows) {
    if (/<th\b/i.test(rowHtml)) {
      continue;
    }
    const cells = extractCells(rowHtml);
    if (cells.length < 4) {
      continue;
    }

    const key = textFromHtml(cells[0]);
    const updatedLabel = textFromHtml(cells[1]);
    const sizeLabel = textFromHtml(cells[2]);
    const channelsCount = parseNumber(textFromHtml(cells[3]));
    const channelsPath = extractAttribute(cells[3], 'href');
    const sourcePath = channelsPath ? toProviderSourcePath(channelsPath) : '';

    if (!key || !channelsPath || !sourcePath) {
      continue;
    }

    providers.push({
      key,
      sourcePath,
      channelsPath,
      updatedLabel,
      sizeLabel,
      channelsCount
    });
  }

  return providers;
};

export const parseChannelsTable = (
  html: string
): { meta: ParsedProviderChannelsMetadata; channels: ParsedChannelRow[] } => {
  const captionHtml = extractCaptionHtml(html);
  const captionText = captionHtml ? textFromHtml(captionHtml) : '';
  const providerLabel = captionHtml
    ? textFromHtml(captionHtml.replace(/<br\s*\/?>/gi, '\n').split('\n')[0] ?? '')
    : null;
  const updatedMatch = captionText.match(/updated:\s*([^\n]+?)\s*channels count:/i);
  const countMatch = captionText.match(/channels count:\s*(\d+)/i);

  const rows = extractRows(html);
  const channels: ParsedChannelRow[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowHtml = rows[rowIndex];
    if (/<th\b/i.test(rowHtml)) {
      continue;
    }
    const cells = extractCells(rowHtml);
    if (cells.length < 4) {
      continue;
    }

    const logoUrlRaw = extractAttribute(cells[0], 'src');
    const displayName = textFromHtml(cells[1]);
    const tvgIdRaw = textFromHtml(cells[2]);
    const epgPathRaw = extractAttribute(cells[3], 'href');

    if (!displayName && !tvgIdRaw && !epgPathRaw) {
      continue;
    }

    const tvgId = tvgIdRaw || null;
    const epgPath = epgPathRaw || null;
    const logoUrl = logoUrlRaw || null;

    channels.push({
      externalKey: buildChannelExternalKey(tvgId, epgPath, displayName, rowIndex),
      displayName,
      tvgId,
      logoUrl,
      epgPath
    });
  }

  return {
    meta: {
      providerLabel: providerLabel || null,
      updatedLabel: updatedMatch?.[1]?.trim() ?? null,
      channelsCount: countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : null
    },
    channels
  };
};

export const parseProgramsTable = (
  html: string
): { meta: ParsedProgramsMetadata; programs: ParsedProgramRow[] } => {
  const captionHtml = extractCaptionHtml(html);
  const captionText = captionHtml ? textFromHtml(captionHtml) : '';
  const channelLabel = captionHtml
    ? textFromHtml(captionHtml.replace(/<br\s*\/?>/gi, '\n').split('\n')[0] ?? '')
    : null;
  const parsedAtMatch = captionText.match(/parced:\s*([^\n]+?)\s*program count:/i);
  const countMatch = captionText.match(/program count:\s*(\d+)/i);

  const rows = extractRows(html);
  const programs: ParsedProgramRow[] = [];
  let sequence = 1;

  for (const rowHtml of rows) {
    if (/<th\b/i.test(rowHtml)) {
      continue;
    }
    const cells = extractCells(rowHtml);
    if (cells.length < 4) {
      continue;
    }

    const dateLabel = textFromHtml(cells[0]);
    const timeLabel = textFromHtml(cells[1]);

    const titleFromAttribute = extractAttribute(cells[2], 'title');
    const descriptionFromAttribute = extractAttribute(cells[3], 'title');

    const title = (titleFromAttribute ?? textFromHtml(cells[2])).trim();
    const descriptionRaw = (descriptionFromAttribute ?? textFromHtml(cells[3])).trim();
    const description = descriptionRaw.length > 0 ? descriptionRaw : null;

    if (!dateLabel && !timeLabel && !title && !description) {
      continue;
    }

    programs.push({
      sequence,
      dateLabel,
      timeLabel,
      title,
      description
    });
    sequence += 1;
  }

  return {
    meta: {
      channelLabel: channelLabel || null,
      parsedAtLabel: parsedAtMatch?.[1]?.trim() ?? null,
      programCount: countMatch?.[1] ? Number.parseInt(countMatch[1], 10) : null
    },
    programs
  };
};
