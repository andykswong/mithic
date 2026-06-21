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
  body?: Uint8Array;
  trailers?: [string, string][];
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
