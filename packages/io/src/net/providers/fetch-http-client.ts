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

    // Create a Request object. `redirect` defaults to the platform default
    // ('follow') unless the caller requests otherwise. The kernel passes
    // 'manual' so it can capability-check each redirect hop (SSRF prevention).
    const headers = new Headers(request.headers);
    const fetchRequest = new Request(url, {
      method: request.method,
      headers,
      body: request.body as BodyInit | undefined,
      redirect: request.redirect,
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
