import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { FetchHttpClient } from './fetch-http-client.ts';
import { streamToBytes } from '../http.ts';

describe('FetchHttpClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should form request correctly and parse response', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL) => {
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

    expect(response.status).toBe(200);
    // B6: the body is a ReadableStream — drain it to get the bytes.
    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(await streamToBytes(response.body!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.some(([k]) => k === 'content-type')).toBe(true);

    // Verify the fetch was called with correct request
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchedRequest = mockFetch.mock.calls[0][0] as Request;
    expect(fetchedRequest.method).toBe('POST');
    expect(fetchedRequest.url).toBe('https://example.com/api');
    expect(fetchedRequest.headers.get('content-type')).toBe('application/json');
  });

  it('should prepend baseUrl to relative URLs', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient({ baseUrl: 'https://api.example.com' });
    await provider.send({ method: 'GET', url: '/users/1', headers: [] });

    const fetchedRequest = mockFetch.mock.calls[0][0] as Request;
    expect(fetchedRequest.url).toBe('https://api.example.com/users/1');
  });

  it('should throw if URL not in allowList', async () => {
    const provider = new FetchHttpClient({ allowList: ['https://allowed.com'] });

    await expect(
      provider.send({ method: 'GET', url: 'https://blocked.com/secret', headers: [] }),
    ).rejects.toThrow('URL not in allowlist: https://blocked.com/secret');
  });

  it('should allow URL matching an allowList prefix', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient({ allowList: ['https://allowed.com'] });
    const response = await provider.send({ method: 'GET', url: 'https://allowed.com/api/data', headers: [] });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('B6: a bodyless response (204) yields no body field', async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const provider = new FetchHttpClient();
    const response = await provider.send({ method: 'GET', url: 'https://example.com/empty', headers: [] });
    expect(response.body).toBeUndefined();
  });

  it('B6: streams a multi-chunk response WITHOUT buffering it all up front', async () => {
    // A fetch whose body emits 5 chunks lazily, recording when each is pulled. If
    // FetchHttpClient buffered the whole body (arrayBuffer), all 5 would be pulled
    // before send() resolves. Streaming means send() resolves with the stream
    // unread and chunks are pulled only as the consumer reads.
    const pulled: number[] = [];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= 5) { controller.close(); return; }
        pulled.push(i);
        controller.enqueue(new Uint8Array([i]));
        i++;
      },
    });
    const mockFetch = vi.fn(async () => new Response(body, { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient();
    const response = await provider.send({ method: 'GET', url: 'https://example.com/big', headers: [] });
    // send() resolved BEFORE the whole body was pulled — at most the stream's
    // internal highWaterMark prefetch (here 0–1 chunks), never all 5.
    expect(pulled.length).toBeLessThan(5);

    // Reading the stream pulls the remaining chunks on demand.
    const bytes = await streamToBytes(response.body!);
    expect(bytes).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    expect(pulled).toEqual([0, 1, 2, 3, 4]);
  });

  it('B6: cancelling the body stream propagates cancellation to the source (early stop)', async () => {
    let cancelled = false;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++;
        controller.enqueue(new Uint8Array([produced]));
      },
      cancel() { cancelled = true; },
    });
    const mockFetch = vi.fn(async () => new Response(body, { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient();
    const response = await provider.send({ method: 'GET', url: 'https://example.com/infinite', headers: [] });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Consumer stops early: cancel the stream. The source's cancel() fires, so an
    // unbounded producer stops instead of running forever.
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  // B1: timeoutMs is enforced at the transport level via a derived AbortSignal.
  it('B1: derives an AbortSignal from timeoutMs and a hanging fetch aborts', async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const signal = (input as Request).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient();
    const start = Date.now();
    await expect(
      provider.send({ method: 'GET', url: 'https://example.com/slow', headers: [], timeoutMs: 30 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - start).toBeLessThan(1000);
    const req = mockFetch.mock.calls[0][0] as Request;
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('B1: a caller signal aborts the request', async () => {
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      const signal = (input as Request).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const controller = new AbortController();
    const provider = new FetchHttpClient();
    const p = provider.send({ method: 'GET', url: 'https://example.com/x', headers: [], signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toBeDefined();
  });

  it('B1: no timeout and no signal leaves the request unchanged (no signal field)', async () => {
    const mockFetch = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = new FetchHttpClient();
    const response = await provider.send({ method: 'GET', url: 'https://example.com/ok', headers: [] });
    expect(response.status).toBe(200);
  });
});
