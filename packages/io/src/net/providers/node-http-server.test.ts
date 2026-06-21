import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { NodeHttpServer } from './node-http-server.ts';
import { bytesToStream } from '../http.ts';
import type { HttpRequest } from '../http.ts';

describe('NodeHttpServer', () => {
  let server: NodeHttpServer;

  beforeEach(() => {
    server = new NodeHttpServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('should start on random port and handler receives requests', async () => {
    let receivedRequest: HttpRequest | null = null;

    await server.listen(async (req) => {
      receivedRequest = req;
      return {
        status: 200,
        headers: [['content-type', 'text/plain']],
        body: bytesToStream(new Uint8Array(Buffer.from('hello'))),
      };
    });

    const port = server.port;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${port}/test?foo=bar`, {
      method: 'GET',
      headers: { 'x-custom': 'value' },
    });

    expect(response.status).toBe(200);
    // TS narrows the closure-assigned `receivedRequest` to its initializer (null)
    // in this flow; the handler did run, so read through `unknown`.
    const request = receivedRequest as unknown as HttpRequest;
    expect(request).not.toBeNull();
    expect(request.method).toBe('GET');
    expect(request.url.includes('/test?foo=bar')).toBe(true);
    expect(request.headers.some(([k, v]) => k === 'x-custom' && v === 'value')).toBe(true);
  });

  it('should respond with status and body', async () => {
    await server.listen(async () => {
      return {
        status: 201,
        headers: [['x-result', 'created']],
        body: bytesToStream(new Uint8Array(Buffer.from('created resource'))),
      };
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/resource`, { method: 'POST' });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-result')).toBe('created');
    expect(await response.text()).toBe('created resource');
  });

  it('B6: streams a multi-chunk response body to the socket', async () => {
    await server.listen(async () => ({
      status: 200,
      headers: [],
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from('chunk-a;')));
          controller.enqueue(new Uint8Array(Buffer.from('chunk-b;')));
          controller.enqueue(new Uint8Array(Buffer.from('chunk-c')));
          controller.close();
        },
      }),
    }));

    const response = await fetch(`http://127.0.0.1:${server.port}/stream`);
    expect(await response.text()).toBe('chunk-a;chunk-b;chunk-c');
  });

  it('should shut down on close()', async () => {
    await server.listen(async () => ({ status: 200, headers: [] }));

    const port = server.port;
    await server.close();

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('should handle POST with body', async () => {
    let receivedBody: Uint8Array | undefined;

    await server.listen(async (req) => {
      receivedBody = req.body;
      return { status: 200, headers: [], body: bytesToStream(new Uint8Array(Buffer.from('ok'))) };
    });

    const payload = JSON.stringify({ name: 'test', value: 42 });
    const response = await fetch(`http://127.0.0.1:${server.port}/data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(receivedBody).toBeDefined();
    expect(new TextDecoder().decode(receivedBody)).toBe(payload);
  });
});
