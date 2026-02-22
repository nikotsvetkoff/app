const ATTRIBUTE_PATTERN = /([a-zA-Z0-9-]+)=(?:"([^"]*)"|([^\s]+))/g;

export const parseExtInfAttributes = (rawAttributes: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;

  while ((match = ATTRIBUTE_PATTERN.exec(rawAttributes)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    attributes[key] = value;
  }

  return attributes;
};
