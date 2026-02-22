export interface FetchRetryOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  headers?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const fetchTextWithRetry = async (
  url: string,
  options: FetchRetryOptions = {}
): Promise<string> => {
  const response = await fetchWithRetry(url, options);
  return response.text();
};

export const fetchWithRetry = async (
  url: string,
  options: FetchRetryOptions = {}
): Promise<Response> => {
  const retries = options.retries ?? 2;
  const backoffMs = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 8000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: options.headers,
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`Ошибка HTTP ${response.status} ${response.statusText}`);
      }

      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Не удалось выполнить запрос');
};
