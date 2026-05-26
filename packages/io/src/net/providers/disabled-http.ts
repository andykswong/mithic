import type { HttpRequest, HttpResponse, HttpServer, IncomingHttpHandler, SyncHttpClient } from '../http.ts';

/** HTTP client that always throws (for sandboxed environments). */
export class DisabledHttpClient implements SyncHttpClient {
  send(_request: HttpRequest): HttpResponse {
    throw new Error('HTTP access is disabled');
  }
}

/** HTTP server that does nothing (for sandboxed environments). */
export class DisabledHttpServer implements HttpServer {
  async listen(_handler: IncomingHttpHandler): Promise<void> {
    throw new Error('HTTP server is disabled');
  }
  async close(): Promise<void> {}
}
