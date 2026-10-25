import { API_URL } from './config';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

type TokenGetter = () => string | null;
let getToken: TokenGetter = () => null;
let onUnauthorized: () => void = () => {};

export function configureApi(opts: { getToken: TokenGetter; onUnauthorized: () => void }) {
  getToken = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON fetch with timeout and retry. Network errors and 5xx responses are retried with exponential
 * backoff (0.5s, 1s, 2s ...). 4xx responses are never retried.
 */
export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; retries?: number; timeoutMs?: number; token?: string | null } = {},
): Promise<T> {
  const retries = opts.retries ?? (opts.method && opts.method !== 'GET' ? 1 : 3);
  let attempt = 0;
  for (;;) {
    const token = opts.token !== undefined ? opts.token : getToken();
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, {
        method: opts.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
    } catch {
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt++);
        continue;
      }
      throw new ApiError(0, 'network', "Can't reach RemotePhonebook. Check your internet connection.");
    }
    if (res.status >= 500 && attempt < retries) {
      await sleep(500 * 2 ** attempt++);
      continue;
    }
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && token) onUnauthorized();
      const err = json?.error ?? {};
      throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
    }
    return json as T;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
