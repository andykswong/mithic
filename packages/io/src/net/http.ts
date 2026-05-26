import type { MaybePromise } from '../types.ts';

export interface HttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  headers: [string, string][];
  body?: Uint8Array;
}

export interface HttpClient {
  send(request: HttpRequest): MaybePromise<HttpResponse>;
  dispose?(): void;
}

export interface SyncHttpClient extends HttpClient {
  send(request: HttpRequest): HttpResponse;
}

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
