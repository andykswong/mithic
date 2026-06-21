import type { MaybePromise } from '../types.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Uint8Array;
  /**
   * Per-request wall-clock timeout in milliseconds. B1: the {@link FetchHttpClient}
   * now ENFORCES this at the transport level by deriving an `AbortSignal` from it
   * and passing it to the underlying `fetch` — previously the field was inert. A
   * request exceeding the timeout aborts (a `TimeoutError`/`AbortError`), which
   * the caller maps to a timeout errno (the kernel → `ETIMEDOUT` → curl exit 28).
   */
  timeoutMs?: number;
  /**
   * B1: optional caller-supplied cancellation signal. When it (or the derived
   * timeout signal) aborts, the in-flight request is aborted. Composed with the
   * `timeoutMs`-derived signal — whichever fires first wins.
   */
  signal?: AbortSignal;
  /**
   * Redirect handling, mirroring the Fetch API `RequestInit.redirect`.
   * `'manual'` makes the client return a 3xx response WITHOUT following it, so a
   * caller (the kernel) can capability-check the redirect target before deciding
   * to follow. `'follow'` lets the client follow internally. Defaults to
   * `'follow'` for backward compatibility, but the kernel always passes
   * `'manual'` to prevent SSRF via cross-origin redirects.
   */
  redirect?: 'follow' | 'manual' | 'error';
}

export interface HttpResponse {
  status: number;
  headers: [string, string][];
  /**
   * B6: the response body as a STREAM, not a buffered `Uint8Array`. The
   * {@link FetchHttpClient} pumps the underlying `fetch` `Response.body`
   * `ReadableStream` straight through instead of `await response.arrayBuffer()`,
   * so a large download never buffers wholesale and a consumer that stops reading
   * (cancels the stream) propagates backpressure/cancellation up to the transport.
   * A bodyless response (204/304/HEAD) omits the field. Mocks/servers that have
   * the bytes in hand build a one-shot stream via {@link bytesToStream}; a kernel
   * (or any consumer) that needs the bytes drains it via {@link streamToBytes}.
   */
  body?: ReadableStream<Uint8Array>;
  trailers?: [string, string][];
}

/** Wrap a byte buffer as a single-chunk `ReadableStream` (for mocks/servers/tests). */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Drain a `ReadableStream<Uint8Array>` fully into one `Uint8Array` (buffered fallback). */
export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) { chunks.push(value); total += value.byteLength; }
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

export interface HttpClient<Sync extends boolean = boolean> {
  send(request: HttpRequest): MaybePromise<HttpResponse, Sync>;
  dispose?(): void;
}

export type SyncHttpClient = HttpClient<true>;

export interface FetchHttpClientOptions {
  /** URL allowlist. If set, only these URL prefixes are permitted. */
  allowList?: string[];
  /** Base URL to prepend to relative URLs. */
  baseUrl?: string;
}

export interface HttpServer {
  /** Start listening for incoming HTTP requests. */
  listen(handler: IncomingHttpHandler): Promise<void>;
  /** Stop listening. */
  close(): Promise<void>;
}

export type IncomingHttpHandler = (request: HttpRequest) => MaybePromise<HttpResponse>;
