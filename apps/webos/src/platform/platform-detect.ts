export const detectWebOs = (): boolean => {
  return typeof window !== 'undefined' && /web0s|webos/i.test(navigator.userAgent);
};
