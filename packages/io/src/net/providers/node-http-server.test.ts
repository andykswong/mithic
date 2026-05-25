import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { NodeHttpServer } from './node-http-server.ts';
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
        body: new Uint8Array(Buffer.from('hello')),
      };
    });

    const port = server.port;
    assert.ok(port > 0, `Expected port > 0, got ${port}`);

    const response = await fetch(`http://127.0.0.1:${port}/test?foo=bar`, {
      method: 'GET',
      headers: { 'x-custom': 'value' },
    });

    assert.strictEqual(response.status, 200);
    assert.ok(receivedRequest !== null);
    const request = receivedRequest as HttpRequest;
    assert.strictEqual(request.method, 'GET');
    assert.ok(request.url.includes('/test?foo=bar'));
    assert.ok(request.headers.some(([k, v]) => k === 'x-custom' && v === 'value'));
  });

  it('should respond with status and body', async () => {
    await server.listen(async () => {
      return {
        status: 201,
        headers: [['x-result', 'created']],
        body: new Uint8Array(Buffer.from('created resource')),
      };
    });

    const response = await fetch(`http://127.0.0.1:${server.port}/resource`, {
      method: 'POST',
    });

    assert.strictEqual(response.status, 201);
    assert.strictEqual(response.headers.get('x-result'), 'created');
    const text = await response.text();
    assert.strictEqual(text, 'created resource');
  });

  it('should shut down on close()', async () => {
    await server.listen(async () => ({
      status: 200,
      headers: [],
    }));

    const port = server.port;
    await server.close();

    // After close, connection should be refused
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${port}/`),
      (err: Error) => {
        // Node fetch throws on connection refused
        return err.message.includes('fetch failed') || err.message.includes('ECONNREFUSED');
      }
    );
  });

  it('should handle POST with body', async () => {
    let receivedBody: Uint8Array | undefined;

    await server.listen(async (req) => {
      receivedBody = req.body;
      return {
        status: 200,
        headers: [],
        body: new Uint8Array(Buffer.from('ok')),
      };
    });

    const payload = JSON.stringify({ name: 'test', value: 42 });
    const response = await fetch(`http://127.0.0.1:${server.port}/data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    assert.strictEqual(response.status, 200);
    assert.ok(receivedBody !== undefined);
    const bodyStr = new TextDecoder().decode(receivedBody);
    assert.strictEqual(bodyStr, payload);
  });
});
