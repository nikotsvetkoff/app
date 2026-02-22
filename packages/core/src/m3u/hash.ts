const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export const stableHash = (input: string): string => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return `ch_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};
