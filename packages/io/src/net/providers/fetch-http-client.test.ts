import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { FetchHttpClient } from './fetch-http-client.ts';

describe('FetchHttpClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  it('should form request correctly and parse response', async (t) => {
    t.after(() => { globalThis.fetch = originalFetch; });

    const mockFetch = mock.fn(async (_input: RequestInfo | URL) => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient();
    const response = await provider.send({
      method: 'POST',
      url: 'https://example.com/api',
      headers: [['content-type', 'application/json']],
      body: new Uint8Array([4, 5, 6]),
    });

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body, new Uint8Array([1, 2, 3]));
    assert.ok(response.headers.some(([k]) => k === 'content-type'));

    // Verify the fetch was called with correct request
    assert.strictEqual(mockFetch.mock.callCount(), 1);
    const fetchedRequest = mockFetch.mock.calls[0].arguments[0] as Request;
    assert.strictEqual(fetchedRequest.method, 'POST');
    assert.strictEqual(fetchedRequest.url, 'https://example.com/api');
    assert.strictEqual(fetchedRequest.headers.get('content-type'), 'application/json');
  });

  it('should prepend baseUrl to relative URLs', async (t) => {
    t.after(() => { globalThis.fetch = originalFetch; });

    const mockFetch = mock.fn(async (_input: RequestInfo | URL) => {
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient({ baseUrl: 'https://api.example.com' });
    await provider.send({
      method: 'GET',
      url: '/users/1',
      headers: [],
    });

    const fetchedRequest = mockFetch.mock.calls[0].arguments[0] as Request;
    assert.strictEqual(fetchedRequest.url, 'https://api.example.com/users/1');
  });

  it('should throw if URL not in allowList', async (t) => {
    t.after(() => { globalThis.fetch = originalFetch; });

    const provider = new FetchHttpClient({
      allowList: ['https://allowed.com'],
    });

    await assert.rejects(
      () => provider.send({
        method: 'GET',
        url: 'https://blocked.com/secret',
        headers: [],
      }),
      { message: 'URL not in allowlist: https://blocked.com/secret' }
    );
  });

  it('should allow URL matching an allowList prefix', async (t) => {
    t.after(() => { globalThis.fetch = originalFetch; });

    const mockFetch = mock.fn(async (_input: RequestInfo | URL) => {
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient({
      allowList: ['https://allowed.com'],
    });

    const response = await provider.send({
      method: 'GET',
      url: 'https://allowed.com/api/data',
      headers: [],
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(mockFetch.mock.callCount(), 1);
  });
});
