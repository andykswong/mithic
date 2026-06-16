import type { MaybePromise } from '../types.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Uint8Array;
  timeoutMs?: number;
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
