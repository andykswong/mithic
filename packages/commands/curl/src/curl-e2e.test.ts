/**
 * End-to-end proof of the whole curl mechanism through the REAL kernel:
 *   resolveCommand → kernel spawn → defineCommand → createGuest → net/fetch
 *   syscall → capability gate → injected MockHttpClient → stdout → exit.
 *
 * Boots a real Kernel over a WorkerRuntime with `resolveCommand =
 * createCurlResolver()` and a MOCK http client (NO real network). In a
 * Node/vitest env `Worker` is undefined, so the kernel's in-process launcher
 * imports the BUILT `dist/curl.js` module by URL and runs it on the same thread.
 *
 * THE KEY SECURITY TEST: a curl to an origin NOT granted via a `net` capability
 * is rejected by the kernel (EACCES) before the http client is ever called —
 * proving the network is capability-gated and the guest cannot escape its grant.
 *
 * REQUIRES the package built first (`npm run build -w @mithic/curl`) so
 * `dist/curl.js` exists — the resolver hands the kernel that file URL.
 */
import { expect, test } from 'vitest';
import { createCurlResolver } from './index.ts';
import type { Capability } from '@mithic/protocol';
import type { HttpRequest, HttpResponse } from '@mithic/io/net';

const GRANTED_ORIGIN = 'https://api.example.com';

async function bootKernel(mock: {
  responses?: Record<string, HttpResponse>;
  onSend?: (req: HttpRequest) => void;
}): Promise<{
  curl: (args: string[], caps?: Capability[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  readFile: (path: string) => Promise<string>;
  requests: HttpRequest[];
}> {
  const [{ Kernel }, { WorkerRuntime }, { FileSystemRouter, MemoryFsProvider }] = await Promise.all([
    import('@mithic/kernel'),
    import('@mithic/runtime/backends/worker'),
    import('@mithic/io/vfs'),
  ]);

  const requests: HttpRequest[] = [];
  const responses = mock.responses ?? {};
  // An inline mock HTTP client: records every request and answers from the table
  // (exact, then prefix match). This is what the kernel injects — no real fetch.
  const httpClient = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      mock.onSend?.(req);
      if (responses[req.url]) return responses[req.url];
      for (const [pattern, resp] of Object.entries(responses)) {
        if (req.url.startsWith(pattern)) return resp;
      }
      throw Object.assign(new Error(`connection refused: ${req.url}`), { code: 'ECONNREFUSED' });
    },
  };

  const vfs = new FileSystemRouter();
  await vfs.mount('/', new MemoryFsProvider());

  const resolveCommand = createCurlResolver();
  const kernel = new Kernel({ runtime: new WorkerRuntime(), vfs, resolveCommand, httpClient });

  return {
    requests,
    async readFile(path) {
      const handle = await vfs.open(path, { read: true });
      const bytes = await vfs.read(handle, 0, 1 << 20);
      await vfs.close(handle);
      return new TextDecoder().decode(bytes);
    },
    async curl(args, caps) {
      const code = resolveCommand(args[0], '/', {})!;
      const { pid, stdout, stderr } = await kernel.spawn(code, {
        args,
        capabilities: caps ?? [{ type: 'net', origins: [GRANTED_ORIGIN] }],
        captureStdout: true,
        captureStderr: true,
      });
      const { code: exitCode } = await kernel.wait(pid);
      const outBytes = stdout ? await stdout : new Uint8Array();
      const errBytes = stderr ? await stderr : new Uint8Array();
      return {
        stdout: new TextDecoder().decode(outBytes),
        stderr: new TextDecoder().decode(errBytes),
        code: exitCode,
      };
    },
  };
}

const enc = new TextEncoder();

test('curl <granted-origin> returns the mock body end-to-end', async () => {
  const k = await bootKernel({
    responses: {
      'https://api.example.com/data': { status: 200, headers: [['content-type', 'application/json']], body: enc.encode('{"ok":true}') },
    },
  });
  const r = await k.curl(['curl', 'https://api.example.com/data']);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('{"ok":true}');
  expect(k.requests).toHaveLength(1);
  expect(k.requests[0].method).toBe('GET');
}, 20000);

test('SECURITY: curl to an origin NOT granted is denied (EACCES) — http client never called', async () => {
  const k = await bootKernel({
    responses: {
      // A response IS configured for the evil origin — to prove the gate, not
      // the mock, is what blocks it. If the gate failed, this body would leak.
      'https://evil.example.org/steal': { status: 200, headers: [], body: enc.encode('SECRET') },
    },
  });
  // Granted only api.example.com; curl to evil.example.org must be blocked.
  const r = await k.curl(['curl', 'https://evil.example.org/steal'], [
    { type: 'net', origins: [GRANTED_ORIGIN] },
  ]);
  expect(r.code).not.toBe(0);            // curl exits non-zero on the denied request
  expect(r.stdout).toBe('');             // the secret body never reaches the guest
  expect(r.stderr).not.toBe('');         // an error is reported
  expect(k.requests).toHaveLength(0);    // the http client was NEVER invoked
}, 20000);

test('SECURITY: a process with NO net capability cannot curl anything (EACCES)', async () => {
  const k = await bootKernel({
    responses: { 'https://api.example.com/data': { status: 200, headers: [], body: enc.encode('body') } },
  });
  const r = await k.curl(['curl', 'https://api.example.com/data'], []); // no caps
  expect(r.code).not.toBe(0);
  expect(r.stdout).toBe('');
  expect(k.requests).toHaveLength(0);
}, 20000);

test('curl -X POST -d sends the body to the granted origin', async () => {
  const k = await bootKernel({
    responses: { 'https://api.example.com/post': { status: 201, headers: [], body: enc.encode('created') } },
  });
  const r = await k.curl(['curl', '-X', 'POST', '-d', 'name=mithic', 'https://api.example.com/post']);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('created');
  expect(k.requests[0].method).toBe('POST');
  expect(new TextDecoder().decode(k.requests[0].body)).toBe('name=mithic');
}, 20000);

test('curl -f against a 404 from the granted origin exits 22', async () => {
  const k = await bootKernel({
    responses: { 'https://api.example.com/missing': { status: 404, headers: [], body: enc.encode('Not Found') } },
  });
  const r = await k.curl(['curl', '-f', 'https://api.example.com/missing']);
  expect(r.code).toBe(22);
  expect(r.stdout).toBe('');
}, 20000);

test('curl -o writes the body to a VFS file (capability-gated origin)', async () => {
  const k = await bootKernel({
    responses: { 'https://api.example.com/file': { status: 200, headers: [], body: enc.encode('downloaded') } },
  });
  // Needs both net (for the fetch) and fs write (for -o).
  const r = await k.curl(['curl', '-o', '/dl.txt', 'https://api.example.com/file'], [
    { type: 'net', origins: [GRANTED_ORIGIN] },
    { type: 'fs', paths: ['/'], operations: ['read', 'write'] },
  ]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('');
  expect(await k.readFile('/dl.txt')).toBe('downloaded');
}, 20000);

test('unknown command name resolves to undefined (kernel would ENOENT)', () => {
  const resolve = createCurlResolver();
  expect(resolve('not-a-command', '/', {})).toBeUndefined();
  expect(resolve('curl', '/', {})).toBeInstanceOf(URL);
});
