import type { HttpClient, HttpRequest, HttpResponse, FetchHttpClientOptions } from '../http.ts';

/** Default HTTP client that delegates to globalThis.fetch. */
export class FetchHttpClient implements HttpClient {
  private options?: FetchHttpClientOptions;

  constructor(options?: FetchHttpClientOptions) {
    this.options = options;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    let url = request.url;

    // Prepend baseUrl if configured and URL is relative
    if (this.options?.baseUrl && !url.startsWith('http://') && !url.startsWith('https://')) {
      const base = this.options.baseUrl.endsWith('/')
        ? this.options.baseUrl
        : this.options.baseUrl + '/';
      url = base + (url.startsWith('/') ? url.slice(1) : url);
    }

    // Check allowList if configured
    if (this.options?.allowList) {
      const allowed = this.options.allowList.some((prefix) => url.startsWith(prefix));
      if (!allowed) {
        throw new Error(`URL not in allowlist: ${url}`);
      }
    }

    // B1: derive a real transport-level AbortSignal. `timeoutMs` (previously
    // inert) becomes an `AbortSignal.timeout`; a caller-supplied `signal` is
    // composed with it via `AbortSignal.any` so whichever fires first aborts the
    // in-flight fetch. A request that exceeds the timeout rejects with a
    // TimeoutError, which the caller (the kernel) maps to ETIMEDOUT (curl exit 28).
    const signal = combineSignals(request.timeoutMs, request.signal);

    // Create a Request object. `redirect` defaults to the platform default
    // ('follow') unless the caller requests otherwise. The kernel passes
    // 'manual' so it can capability-check each redirect hop (SSRF prevention).
    const headers = new Headers(request.headers);
    const fetchRequest = new Request(url, {
      method: request.method,
      headers,
      body: request.body as BodyInit | undefined,
      redirect: request.redirect,
      ...(signal ? { signal } : {}),
    });

    // Call fetch
    const response = await fetch(fetchRequest);

    // Convert Response to HttpResponse
    const responseHeaders: [string, string][] = [];
    response.headers.forEach((value, key) => {
      responseHeaders.push([key, value]);
    });

    const arrayBuffer = await response.arrayBuffer();
    const body = arrayBuffer.byteLength > 0 ? new Uint8Array(arrayBuffer) : undefined;

    return {
      status: response.status,
      headers: responseHeaders,
      body,
    };
  }
}

/**
 * B1: build the AbortSignal to pass to `fetch` from a `timeoutMs` and/or a
 * caller-supplied `signal`. Returns:
 *   - `undefined` when neither is set (no signal field → unchanged behavior);
 *   - the lone signal when only one source is present;
 *   - `AbortSignal.any([timeout, caller])` when both are present (first abort wins).
 */
function combineSignals(timeoutMs: number | undefined, caller: AbortSignal | undefined): AbortSignal | undefined {
  const timeout = typeof timeoutMs === 'number' && timeoutMs >= 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (timeout && caller) return AbortSignal.any([timeout, caller]);
  return timeout ?? caller;
}
