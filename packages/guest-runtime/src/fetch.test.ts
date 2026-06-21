import { expect, test, vi } from 'vitest';
import { createFetch } from './fetch.ts';
import { portToWritable } from './streams.ts';
import type { SyscallCallOptions, SyscallResult } from './syscall-client.ts';

const enc = new TextEncoder();

/**
 * Build a fake ports-aware syscall hook that records `net/fetch` calls and
 * answers from `responder`. Mirrors the kernel `net/fetch` wire shape: a
 * buffered `{status, headers, body}` (returned with no ports), which the fake
 * wraps in a `SyscallResult` so the façade's port plumbing is exercised.
 */
function fakeSyscall(
  responder: (args: Record<string, unknown>, opts?: SyscallCallOptions) =>
    { status: number; statusText?: string; headers: [string, string][]; body?: Uint8Array } | Error,
): {
  syscall: (call: string, args: Record<string, unknown>, opts?: SyscallCallOptions) => Promise<SyscallResult>;
  calls: Array<{ args: Record<string, unknown>; opts?: SyscallCallOptions }>;
} {
  const calls: Array<{ args: Record<string, unknown>; opts?: SyscallCallOptions }> = [];
  return {
    calls,
    async syscall(call, args, opts) {
      if (call !== 'net/fetch') throw new Error(`unexpected syscall: ${call}`);
      calls.push({ args, opts });
      const r = responder(args, opts);
      if (r instanceof Error) throw r;
      return { result: r, ports: [] };
    },
  };
}

test('B2: fetch(url, {method, body}) round-trips to a real Response', async () => {
  const { syscall, calls } = fakeSyscall(() => ({
    status: 201,
    statusText: 'Created',
    headers: [['content-type', 'application/json']],
    body: enc.encode('{"ok":true}'),
  }));
  const fetch = createFetch(syscall);

  const res = await fetch('http://x/post', { method: 'POST', body: 'name=mithic' });

  // It is a real WHATWG Response.
  expect(res).toBeInstanceOf(Response);
  expect(res.status).toBe(201);
  expect(res.statusText).toBe('Created');
  expect(res.ok).toBe(true);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(await res.text()).toBe('{"ok":true}');

  // The wire args carry the standard method/url/headers/body.
  expect(calls).toHaveLength(1);
  expect(calls[0].args.method).toBe('POST');
  expect(calls[0].args.url).toBe('http://x/post');
  const body = calls[0].args.body as Uint8Array;
  expect(new TextDecoder().decode(body)).toBe('name=mithic');
});

test('B2: Response.arrayBuffer() yields the raw bytes', async () => {
  const bytes = enc.encode('binary-ish');
  const { syscall } = fakeSyscall(() => ({ status: 200, headers: [], body: bytes }));
  const fetch = createFetch(syscall);

  const res = await fetch('http://x/blob');
  const ab = await res.arrayBuffer();
  expect(new Uint8Array(ab)).toEqual(bytes);
});

test('B2: a Request object is accepted as input', async () => {
  const { syscall, calls } = fakeSyscall(() => ({ status: 200, headers: [], body: enc.encode('hi') }));
  const fetch = createFetch(syscall);

  const req = new Request('http://x/get', { method: 'GET', headers: { 'x-test': '1' } });
  const res = await fetch(req);
  expect(await res.text()).toBe('hi');
  expect(calls[0].args.method).toBe('GET');
  expect(calls[0].args.url).toBe('http://x/get');
  const headers = calls[0].args.headers as [string, string][];
  expect(headers.some(([k, v]) => k.toLowerCase() === 'x-test' && v === '1')).toBe(true);
});

test('B2: a string body and a Uint8Array body both reach the wire as bytes', async () => {
  const { syscall, calls } = fakeSyscall(() => ({ status: 200, headers: [], body: new Uint8Array() }));
  const fetch = createFetch(syscall);

  await fetch('http://x/a', { method: 'POST', body: enc.encode('raw') });
  expect(new TextDecoder().decode(calls[0].args.body as Uint8Array)).toBe('raw');
});

test('B2: a GET with no body sends no body field on the wire', async () => {
  const { syscall, calls } = fakeSyscall(() => ({ status: 200, headers: [], body: new Uint8Array() }));
  const fetch = createFetch(syscall);

  await fetch('http://x/get');
  expect('body' in calls[0].args).toBe(false);
});

test('B2: init.signal threads a live AbortSignal through to the syscall opts', async () => {
  const { syscall, calls } = fakeSyscall(() => ({ status: 200, headers: [], body: new Uint8Array() }));
  const fetch = createFetch(syscall);

  const ac = new AbortController();
  await fetch('http://x/get', { signal: ac.signal });
  // A signal is forwarded (the Request wraps the caller's into a linked signal),
  // and aborting the caller's controller aborts the threaded signal too.
  const threaded = calls[0].opts?.signal;
  expect(threaded).toBeInstanceOf(AbortSignal);
  expect(threaded!.aborted).toBe(false);
  ac.abort();
  expect(threaded!.aborted).toBe(true);
});

test('B2: an already-aborted signal rejects without ever calling the syscall', async () => {
  const inner = vi.fn();
  const fetch = createFetch(async (_call, _args, _opts) => { inner(); return { result: { status: 200, headers: [] }, ports: [] }; });

  const ac = new AbortController();
  ac.abort();
  await expect(fetch('http://x/get', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(inner).not.toHaveBeenCalled();
});

test('B2: aborting mid-flight rejects the fetch (ECANCELED → AbortError)', async () => {
  const ac = new AbortController();
  // A syscall that rejects with ECANCELED when its signal aborts (mirrors SyscallClient).
  const fetch = createFetch((_call, _args, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('syscall canceled'), { code: 'ECANCELED' }));
      });
    }) as Promise<SyscallResult>);

  const p = fetch('http://x/slow', { signal: ac.signal });
  ac.abort();
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
});

test('B2: a Headers init is normalized to [name,value][] on the wire', async () => {
  const { syscall, calls } = fakeSyscall(() => ({ status: 200, headers: [], body: new Uint8Array() }));
  const fetch = createFetch(syscall);

  await fetch('http://x/h', { headers: new Headers({ 'X-A': '1', 'X-B': '2' }) });
  const headers = calls[0].args.headers as [string, string][];
  expect(headers.find(([k]) => k.toLowerCase() === 'x-a')?.[1]).toBe('1');
  expect(headers.find(([k]) => k.toLowerCase() === 'x-b')?.[1]).toBe('2');
});

// ── B6: streaming Response.body over a transferred port ─────────────────────

/**
 * Mirror the kernel's TRANSFERABLE-backend delivery: return `{status, headers,
 * bodyStream: true}` plus a transferred read port, and drive the kernel-side
 * write end with `portToWritable` so the guest reads a live stream. Returns the
 * write-side WritableStream so the test acts as the "kernel pump".
 */
function streamingSyscall(status = 200, headers: [string, string][] = []): {
  syscall: (call: string, args: Record<string, unknown>, opts?: SyscallCallOptions) => Promise<SyscallResult>;
  kernelWritable: WritableStream<Uint8Array>;
} {
  const channel = new MessageChannel();
  const kernelWritable = portToWritable(channel.port2);
  return {
    kernelWritable,
    async syscall(call, _args, _opts) {
      if (call !== 'net/fetch') throw new Error(`unexpected syscall: ${call}`);
      return { result: { status, headers, bodyStream: true }, ports: [channel.port1] };
    },
  };
}

test('B6: a streamed body (bodyStream + transferred port) is a real ReadableStream', async () => {
  const { syscall, kernelWritable } = streamingSyscall(200, [['content-type', 'text/plain']]);
  const fetch = createFetch(syscall);

  const res = await fetch('http://x/big');
  expect(res.status).toBe(200);
  expect(res.body).toBeInstanceOf(ReadableStream);

  // Kernel side writes three chunks then closes.
  const w = kernelWritable.getWriter();
  await w.write(enc.encode('part-1;'));
  await w.write(enc.encode('part-2;'));
  await w.write(enc.encode('part-3'));
  await w.close();

  expect(await res.text()).toBe('part-1;part-2;part-3');
});

test('B6: streamed chunks arrive incrementally (not buffered whole before the first read)', async () => {
  const { syscall, kernelWritable } = streamingSyscall();
  const fetch = createFetch(syscall);
  const res = await fetch('http://x/stream');
  const reader = res.body!.getReader();
  const w = kernelWritable.getWriter();

  await w.write(enc.encode('A'));
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(new TextDecoder().decode(first.value)).toBe('A');

  await w.write(enc.encode('B'));
  const second = await reader.read();
  expect(new TextDecoder().decode(second.value)).toBe('B');

  await w.close();
  const end = await reader.read();
  expect(end.done).toBe(true);
});

test('B6: cancelling the streamed body propagates EPIPE to the kernel write end (early stop)', async () => {
  const { syscall, kernelWritable } = streamingSyscall();
  const fetch = createFetch(syscall);
  const res = await fetch('http://x/infinite');

  const reader = res.body!.getReader();
  const w = kernelWritable.getWriter();
  await w.write(enc.encode('first'));
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('first');

  // Consumer cancels (e.g. `head -c5` got enough). portToReadable.cancel() posts
  // {type:'error', code:'EPIPE'} to the kernel write end, which latches its
  // PipeWriter broken and rejects further writes — proving the abort propagates.
  await reader.cancel();
  await expect(w.write(enc.encode('more'))).rejects.toMatchObject({ code: 'EPIPE' });
});

test('B6: init.signal aborting cancels the in-flight streamed body', async () => {
  const { syscall, kernelWritable } = streamingSyscall();
  const fetch = createFetch(syscall);
  const ac = new AbortController();
  const res = await fetch('http://x/abortable', { signal: ac.signal });

  const reader = res.body!.getReader();
  const w = kernelWritable.getWriter();
  await w.write(enc.encode('chunk'));
  await reader.read();

  // Aborting the request signal cancels the body stream; the cancel posts EPIPE
  // up the port. Let that message round-trip the channel, then the kernel write
  // end has latched broken and rejects further writes.
  ac.abort();
  await new Promise((r) => setTimeout(r, 10));
  await expect(w.write(enc.encode('more'))).rejects.toMatchObject({ code: 'EPIPE' });
});
