import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { HttpServer, IncomingHttpHandler, HttpRequest } from '../http.ts';

/**
 * HTTP server backed by Node.js http.createServer.
 * Routes incoming requests to the provided handler.
 */
export class NodeHttpServer implements HttpServer {
  #server: Server | null = null;
  #port: number;
  #hostname: string;

  constructor(options?: { port?: number; hostname?: string }) {
    this.#port = options?.port ?? 0; // 0 = random available port
    this.#hostname = options?.hostname ?? '127.0.0.1';
  }

  get port(): number {
    const addr = this.#server?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.#port;
  }

  async listen(handler: IncomingHttpHandler): Promise<void> {
    this.#server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const httpRequest = await incomingMessageToRequest(req);
      const httpResponse = await handler(httpRequest);
      res.writeHead(httpResponse.status, Object.fromEntries(httpResponse.headers));
      if (httpResponse.body) {
        // B6: the response body is a ReadableStream — pump it to the socket in
        // chunks rather than buffering it whole.
        const reader = httpResponse.body.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
        res.end();
      } else {
        res.end();
      }
    });

    return new Promise((resolve) => {
      this.#server!.listen(this.#port, this.#hostname, () => resolve());
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.#server) { resolve(); return; }
      this.#server.close((err) => err ? reject(err) : resolve());
      this.#server = null;
    });
  }
}

async function incomingMessageToRequest(req: IncomingMessage): Promise<HttpRequest> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers: [string, string][] = [];
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.push([key, value]);
    } else if (Array.isArray(value)) {
      for (const v of value) headers.push([key, v]);
    }
  }

  const body = await readBody(req);

  return {
    method: req.method ?? 'GET',
    url,
    headers,
    body: body.length > 0 ? body : undefined,
  };
}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', () => resolve(new Uint8Array(0)));
  });
}
