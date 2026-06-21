/**
 * CU1 (kernel half) — net/fetch 307/308 redirects must PRESERVE method + body.
 *
 * RFC 7231 §6.4.7 (307 Temporary Redirect) and RFC 7538 (308 Permanent Redirect)
 * require the method and request body to be preserved across the redirect. The
 * kernel previously downgraded EVERY 3xx to GET and dropped the body, which
 * breaks POST-following-307 (e.g. an API that 307s to a regional endpoint).
 *
 * 301/302/303 keep their existing behavior: the body is dropped and (for a
 * non-idempotent method) the method becomes GET — matching browser fetch.
 *
 * The SSRF per-hop capability re-check is preserved regardless of status.
 */
import { expect, test } from 'vitest';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import { CapabilityManager } from './capability-manager.ts';
import type { HttpClient, HttpRequest, HttpResponse } from '@mithic/io/net';
import { bytesToStream } from '@mithic/io/net';
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

/** A scripted response authored with BYTES (B6: HttpResponse.body is a stream). */
interface ScriptedResponse { status: number; headers: [string, string][]; body?: Uint8Array }

/** Records every request it receives, replying with a scripted sequence of responses. */
class RecordingHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  #queue: ScriptedResponse[];
  constructor(queue: ScriptedResponse[]) { this.#queue = queue; }
  async send(request: HttpRequest): Promise<HttpResponse> {
    // Deep-copy the request so later mutation by the dispatcher can't alter our log.
    this.requests.push({ ...request, headers: [...request.headers] });
    const next = this.#queue.shift() ?? { status: 200, headers: [] };
    const out: HttpResponse = { status: next.status, headers: next.headers };
    if (next.body !== undefined) out.body = bytesToStream(next.body);
    return out;
  }
}

function dispatcherWith(client: HttpClient): { d: SyscallDispatcher; pid: number } {
  const caps = new CapabilityManager();
  const pid = 1;
  caps.grant(pid, [{ type: 'net', origins: ['https://api.example.com', 'https://eu.example.com'] }]);
  const vfs = new FileSystemRouter();
  void vfs.mount('/', new MemoryFsProvider());
  const d = new SyscallDispatcher({ vfs, caps, cwdOf: () => '/', httpClient: client });
  return { d, pid };
}

const bodyBytes = new TextEncoder().encode('{"k":"v"}');

test('307 preserves POST method and body across the redirect', async () => {
  const client = new RecordingHttpClient([
    { status: 307, headers: [['location', 'https://eu.example.com/v2']] },
    { status: 200, headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('ok') },
  ]);
  const { d, pid } = dispatcherWith(client);

  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch',
    args: { method: 'POST', url: 'https://api.example.com/v1', body: bodyBytes },
  });

  expect(response.ok).toBe(true);
  // First hop: the original POST + body.
  expect(client.requests[0].method).toBe('POST');
  expect(client.requests[0].body).toEqual(bodyBytes);
  // Second hop (the 307 target): method AND body PRESERVED.
  expect(client.requests[1].url).toBe('https://eu.example.com/v2');
  expect(client.requests[1].method).toBe('POST');
  expect(client.requests[1].body).toEqual(bodyBytes);
});

test('308 preserves PUT method and body across the redirect', async () => {
  const client = new RecordingHttpClient([
    { status: 308, headers: [['location', 'https://eu.example.com/moved']] },
    { status: 200, headers: [] },
  ]);
  const { d, pid } = dispatcherWith(client);

  await d.dispatch(pid, {
    id: 1, call: 'net/fetch',
    args: { method: 'PUT', url: 'https://api.example.com/old', body: bodyBytes },
  });

  expect(client.requests[1].method).toBe('PUT');
  expect(client.requests[1].body).toEqual(bodyBytes);
});

test('303 turns a POST into GET and drops the body (existing behavior)', async () => {
  const client = new RecordingHttpClient([
    { status: 303, headers: [['location', 'https://eu.example.com/result']] },
    { status: 200, headers: [] },
  ]);
  const { d, pid } = dispatcherWith(client);

  await d.dispatch(pid, {
    id: 1, call: 'net/fetch',
    args: { method: 'POST', url: 'https://api.example.com/submit', body: bodyBytes },
  });

  expect(client.requests[1].method).toBe('GET');
  expect(client.requests[1].body).toBeUndefined();
});

test('301/302 downgrade a non-idempotent POST to GET and drop the body (existing behavior)', async () => {
  for (const status of [301, 302]) {
    const client = new RecordingHttpClient([
      { status, headers: [['location', 'https://eu.example.com/x']] },
      { status: 200, headers: [] },
    ]);
    const { d, pid } = dispatcherWith(client);
    await d.dispatch(pid, {
      id: 1, call: 'net/fetch',
      args: { method: 'POST', url: 'https://api.example.com/p', body: bodyBytes },
    });
    expect(client.requests[1].method, `status ${status}`).toBe('GET');
    expect(client.requests[1].body, `status ${status}`).toBeUndefined();
  }
});

test('301/302 PRESERVE a GET (no body) — method stays GET', async () => {
  const client = new RecordingHttpClient([
    { status: 301, headers: [['location', 'https://eu.example.com/g']] },
    { status: 200, headers: [] },
  ]);
  const { d, pid } = dispatcherWith(client);
  await d.dispatch(pid, { id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/g' } });
  expect(client.requests[1].method).toBe('GET');
});

test('307 to an UNGRANTED origin is still denied (SSRF per-hop re-check preserved)', async () => {
  const client = new RecordingHttpClient([
    { status: 307, headers: [['location', 'http://169.254.169.254/latest/meta-data']] },
  ]);
  const { d, pid } = dispatcherWith(client);
  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch',
    args: { method: 'POST', url: 'https://api.example.com/v1', body: bodyBytes },
  });
  expect(response.ok).toBe(false);
  expect((response as { ok: false; error: { code: string } }).error.code).toBe('EACCES');
  // The ungranted target must NEVER be fetched — only the first hop happened.
  expect(client.requests).toHaveLength(1);
});

// --- B1: AbortSignal/timeout threading for net/fetch ---

/**
 * A mock client that respects the request's AbortSignal: it never resolves on
 * its own (a hanging server), so the ONLY way send() settles is the signal
 * aborting — exactly what `timeoutMs` should produce. Throws a DOMException-like
 * abort error matching what real `fetch` throws on AbortSignal.timeout.
 */
class HangingHttpClient implements HttpClient {
  lastSignal: AbortSignal | undefined;
  send(request: HttpRequest): Promise<HttpResponse> {
    this.lastSignal = request.signal;
    return new Promise<HttpResponse>((_resolve, reject) => {
      const onAbort = () => {
        const err = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
        reject(err);
      };
      if (request.signal?.aborted) { onAbort(); return; }
      request.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

test('B1: a fetch with a short timeout against a hanging server aborts with ETIMEDOUT', async () => {
  const client = new HangingHttpClient();
  const { d, pid } = dispatcherWith(client);

  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch',
    args: { method: 'GET', url: 'https://api.example.com/slow', timeoutMs: 20 },
  });

  expect(response.ok).toBe(false);
  // ETIMEDOUT is the curl-mappable code (curl --max-time → exit 28), distinct
  // from EHOSTUNREACH (a connection failure → exit 7).
  expect((response as { ok: false; error: { code: string } }).error.code).toBe('ETIMEDOUT');
  // The dispatcher derived a real AbortSignal and passed it to the client.
  expect(client.lastSignal).toBeInstanceOf(AbortSignal);
});

test('B1: a normal fetch is unaffected — no signal derived when timeoutMs is unset', async () => {
  const client = new RecordingHttpClient([
    { status: 200, headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('ok') },
  ]);
  const { d, pid } = dispatcherWith(client);

  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch', args: { method: 'GET', url: 'https://api.example.com/fast' },
  });

  expect(response.ok).toBe(true);
  // No timeoutMs → no signal field threaded to the client (unchanged behavior).
  expect(client.requests[0].signal).toBeUndefined();
});

test('B1: the same timeout signal is threaded to EVERY redirect hop (one budget for the whole chain)', async () => {
  const client = new RecordingHttpClient([
    { status: 307, headers: [['location', 'https://eu.example.com/v2']] },
    { status: 200, headers: [], body: new TextEncoder().encode('ok') },
  ]);
  const { d, pid } = dispatcherWith(client);

  const { response } = await d.dispatch(pid, {
    id: 1, call: 'net/fetch',
    args: { method: 'GET', url: 'https://api.example.com/v1', timeoutMs: 5000 },
  });

  expect(response.ok).toBe(true);
  // SSRF per-hop re-check still intact (second hop happened against granted origin)
  // AND both hops share ONE AbortSignal instance (the chain-wide timeout budget).
  expect(client.requests).toHaveLength(2);
  expect(client.requests[0].signal).toBeInstanceOf(AbortSignal);
  expect(client.requests[1].signal).toBe(client.requests[0].signal);
});
