export const detectTizen = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.webapis?.avplay);
};
