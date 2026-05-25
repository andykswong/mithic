import type { HttpClient, HttpRequest, HttpResponse, HttpServer, IncomingHttpHandler } from '../http.ts';

/** HTTP client that always throws (for sandboxed environments). */
export class DisabledHttpClient implements HttpClient {
  async send(_request: HttpRequest): Promise<HttpResponse> {
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
