import type { MaybePromise } from '../types.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Uint8Array;
  timeoutMs?: number;
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
