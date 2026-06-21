import type { HttpClient, HttpRequest, HttpResponse } from '../http.ts';
import { bytesToStream, streamToBytes } from '../http.ts';

/**
 * The shape callers register with {@link MockHttpClient.addResponse}: like an
 * {@link HttpResponse} but with the body as plain BYTES (a `Uint8Array`). The
 * mock re-mints a FRESH `ReadableStream` body on every `send` (a stream is
 * single-use, so reusing one object across matches would fail the second read).
 */
export interface MockResponse {
  status: number;
  headers: [string, string][];
  body?: Uint8Array;
  trailers?: [string, string][];
}

/** HTTP client that returns preconfigured responses (for testing). */
export class MockHttpClient implements HttpClient {
  private responses: Map<string, MockResponse> = new Map();

  /**
   * Register a mock response for a URL pattern. The body is given as BYTES; each
   * matching `send` builds a fresh single-use stream from them. An
   * {@link HttpResponse} (streaming body) is also accepted and drained to bytes
   * once at registration time for back-compat.
   */
  addResponse(urlPattern: string, response: MockResponse | HttpResponse): void {
    void this.#register(urlPattern, response);
  }

  async #register(urlPattern: string, response: MockResponse | HttpResponse): Promise<void> {
    let body: Uint8Array | undefined;
    if (response.body instanceof ReadableStream) {
      body = await streamToBytes(response.body);
    } else {
      body = response.body;
    }
    const entry: MockResponse = { status: response.status, headers: response.headers };
    if (body !== undefined) entry.body = body;
    if (response.trailers !== undefined) entry.trailers = response.trailers;
    this.responses.set(urlPattern, entry);
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    // Try exact match first, then prefix match
    const response = this.responses.get(request.url) ?? this.#prefixMatch(request.url);
    if (response) return this.#toResponse(response);
    throw new Error(`No mock response configured for: ${request.url}`);
  }

  #prefixMatch(url: string): MockResponse | undefined {
    for (const [pattern, resp] of this.responses) {
      if (url.startsWith(pattern)) return resp;
    }
    return undefined;
  }

  /** Mint a fresh-bodied {@link HttpResponse} from a stored byte-bearing entry. */
  #toResponse(entry: MockResponse): HttpResponse {
    const out: HttpResponse = { status: entry.status, headers: entry.headers };
    if (entry.body !== undefined) out.body = bytesToStream(entry.body);
    if (entry.trailers !== undefined) out.trailers = entry.trailers;
    return out;
  }
}
