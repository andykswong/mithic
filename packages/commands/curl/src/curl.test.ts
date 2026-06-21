/**
 * Unit tests for the curl command LOGIC, driven through a fake {@link CommandIO}
 * whose `syscall` stubs `net/fetch`. No kernel, no network — these verify flag
 * parsing, request construction, output formatting, and exit codes. The kernel
 * end-to-end wiring (and the capability gate) is proven in `curl-e2e.test.ts`.
 */
import { expect, test } from 'vitest';
import { createFetch } from '@mithic/guest-runtime';
import { curlCommand } from './curl.ts';
import type { CommandIO } from './harness.ts';

interface NetFetchCall { method: string; url: string; headers: [string, string][]; body?: Uint8Array }
interface NetFetchResult { status: number; headers: [string, string][]; body?: Uint8Array }

/** Build a fake CommandIO. `responder` answers `net/fetch`; `fsWrites` records `fs/*`. */
function fakeIO(
  args: string[],
  opts: {
    responder?: (call: NetFetchCall) => NetFetchResult | Error;
    stdin?: string;
    env?: Record<string, string>;
  } = {},
): {
  io: CommandIO;
  out: () => string;
  err: () => string;
  netCalls: NetFetchCall[];
  fsFiles: Map<string, Uint8Array>;
} {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const netCalls: NetFetchCall[] = [];
  const fsFiles = new Map<string, Uint8Array>();
  const fsFds = new Map<number, { path: string; buf: Uint8Array[] }>();
  let nextFd = 3;

  const sink = (chunks: Uint8Array[]): WritableStream<Uint8Array> =>
    new WritableStream<Uint8Array>({ write(c) { chunks.push(c); } });

  const responder = opts.responder ?? (() => ({ status: 200, headers: [], body: enc.encode('') }));

  const io: CommandIO = {
    args,
    env: opts.env ?? {},
    cwd: '/',
    stdin: new ReadableStream<Uint8Array>({
      start(controller) {
        if (opts.stdin !== undefined) controller.enqueue(enc.encode(opts.stdin));
        controller.close();
      },
    }),
    stdout: sink(outChunks),
    stderr: sink(errChunks),
    async syscall(call, sargs) {
      if (call === 'net/fetch') {
        const c: NetFetchCall = {
          method: String(sargs.method),
          url: String(sargs.url),
          headers: (sargs.headers as [string, string][]) ?? [],
          body: sargs.body as Uint8Array | undefined,
        };
        netCalls.push(c);
        const r = responder(c);
        if (r instanceof Error) throw r;
        return r;
      }
      if (call === 'fs/open') {
        const raw = String(sargs.path);
        // Mirror the kernel: resolve a relative path against cwd ('/').
        const path = raw.startsWith('/') ? raw : (io.cwd === '/' ? '/' + raw : io.cwd + '/' + raw);
        const fd = nextFd++;
        fsFds.set(fd, { path, buf: [] });
        return { fd };
      }
      if (call === 'fs/write') {
        const fd = Number(sargs.fd);
        const entry = fsFds.get(fd);
        if (entry) entry.buf.push(sargs.data as Uint8Array);
        return { written: (sargs.data as Uint8Array).byteLength };
      }
      if (call === 'fs/close') {
        const fd = Number(sargs.fd);
        const entry = fsFds.get(fd);
        if (entry) {
          const total = entry.buf.reduce((n, b) => n + b.byteLength, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const b of entry.buf) { merged.set(b, off); off += b.byteLength; }
          fsFiles.set(entry.path, merged);
        }
        return {};
      }
      throw new Error(`unexpected syscall: ${call}`);
    },
    // B2: curl now reaches the network through the standard fetch() façade. The
    // façade is built over THIS fake `syscall`, so the `net/fetch` responder and
    // `netCalls` capture above still drive and observe every request.
    fetch: createFetch((call, sargs) => io.syscall(call, sargs)),
  };

  return {
    io,
    out: () => dec.decode(concat(outChunks)),
    err: () => dec.decode(concat(errChunks)),
    netCalls,
    fsFiles,
  };
}

/**
 * Find a header value case-insensitively. The B2 fetch() façade routes headers
 * through a WHATWG `Headers` object, which lowercases header names on the wire
 * (standards-correct — HTTP/2 lowercases too). The header VALUE curl sends is
 * unchanged; only the name's case normalizes, so assertions match by lower-case.
 */
function headerVal(headers: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([k]) => k.toLowerCase() === lower)?.[1];
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of chunks) { out.set(b, off); off += b.byteLength; }
  return out;
}

const enc = new TextEncoder();

test('GET prints the body to stdout and exits 0', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/data'], {
    responder: () => ({ status: 200, headers: [['content-type', 'text/plain']], body: enc.encode('hello body') }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.out()).toBe('hello body');
  expect(f.netCalls[0]).toMatchObject({ method: 'GET', url: 'https://api.example.com/data' });
});

test('-X sets the method', async () => {
  const f = fakeIO(['curl', '-X', 'DELETE', 'https://api.example.com/x']);
  await curlCommand(f.io);
  expect(f.netCalls[0].method).toBe('DELETE');
});

test('-H adds repeated headers', async () => {
  const f = fakeIO(['curl', '-H', 'X-A: 1', '-H', 'X-B: 2', 'https://api.example.com/x']);
  await curlCommand(f.io);
  expect(headerVal(f.netCalls[0].headers, 'X-A')).toBe('1');
  expect(headerVal(f.netCalls[0].headers, 'X-B')).toBe('2');
});

test('-d implies POST and sends the body with form content-type', async () => {
  const f = fakeIO(['curl', '-d', 'a=1&b=2', 'https://api.example.com/p']);
  await curlCommand(f.io);
  expect(f.netCalls[0].method).toBe('POST');
  expect(new TextDecoder().decode(f.netCalls[0].body)).toBe('a=1&b=2');
  expect(headerVal(f.netCalls[0].headers, 'Content-Type')).toBe('application/x-www-form-urlencoded');
});

test('--json sets content-type and accept to application/json', async () => {
  const f = fakeIO(['curl', '--json', '{"a":1}', 'https://api.example.com/p']);
  await curlCommand(f.io);
  expect(f.netCalls[0].method).toBe('POST');
  expect(new TextDecoder().decode(f.netCalls[0].body)).toBe('{"a":1}');
  expect(headerVal(f.netCalls[0].headers, 'Content-Type')).toBe('application/json');
  expect(headerVal(f.netCalls[0].headers, 'Accept')).toBe('application/json');
});

test('-G moves data into the query string and keeps GET', async () => {
  const f = fakeIO(['curl', '-G', '-d', 'q=hello', '-d', 'n=2', 'https://api.example.com/search']);
  await curlCommand(f.io);
  expect(f.netCalls[0].method).toBe('GET');
  expect(f.netCalls[0].url).toBe('https://api.example.com/search?q=hello&n=2');
  expect(f.netCalls[0].body).toBeUndefined();
});

test('-I / --head issues a HEAD request and prints headers', async () => {
  const f = fakeIO(['curl', '-I', 'https://api.example.com/x'], {
    responder: () => ({ status: 200, headers: [['content-length', '42']], body: undefined }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.netCalls[0].method).toBe('HEAD');
  expect(f.out()).toContain('HTTP/1.1 200');
  expect(f.out()).toContain('content-length: 42');
});

test('-i includes response headers before the body', async () => {
  const f = fakeIO(['curl', '-i', 'https://api.example.com/x'], {
    responder: () => ({ status: 201, headers: [['x-id', 'abc']], body: enc.encode('created') }),
  });
  await curlCommand(f.io);
  const o = f.out();
  expect(o).toContain('HTTP/1.1 201');
  expect(o).toContain('x-id: abc');
  expect(o).toContain('created');
  expect(o.indexOf('x-id')).toBeLessThan(o.indexOf('created'));
});

test('-o writes the body to a VFS file instead of stdout', async () => {
  const f = fakeIO(['curl', '-o', '/out.txt', 'https://api.example.com/x'], {
    responder: () => ({ status: 200, headers: [], body: enc.encode('file body') }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.out()).toBe('');
  expect(new TextDecoder().decode(f.fsFiles.get('/out.txt'))).toBe('file body');
});

test('-O derives the output filename from the URL path', async () => {
  const f = fakeIO(['curl', '-O', 'https://api.example.com/path/report.csv'], {
    responder: () => ({ status: 200, headers: [], body: enc.encode('csv') }),
  });
  await curlCommand(f.io);
  expect(new TextDecoder().decode(f.fsFiles.get('/report.csv'))).toBe('csv');
});

test('-f makes an HTTP >= 400 fail with exit code 22 and no body output', async () => {
  const f = fakeIO(['curl', '-f', 'https://api.example.com/missing'], {
    responder: () => ({ status: 404, headers: [], body: enc.encode('Not Found') }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(22);
  expect(f.out()).toBe('');
});

test('without -f an HTTP 404 still prints the body and exits 0', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/missing'], {
    responder: () => ({ status: 404, headers: [], body: enc.encode('Not Found') }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.out()).toBe('Not Found');
});

test('-u adds a Basic Authorization header', async () => {
  const f = fakeIO(['curl', '-u', 'alice:secret', 'https://api.example.com/x']);
  await curlCommand(f.io);
  const auth = f.netCalls[0].headers.find(([k]) => k.toLowerCase() === 'authorization');
  expect(auth?.[1]).toBe('Basic ' + btoa('alice:secret'));
});

test('-A sets the User-Agent and -e sets the Referer', async () => {
  const f = fakeIO(['curl', '-A', 'mybot/1.0', '-e', 'https://ref.example', 'https://api.example.com/x']);
  await curlCommand(f.io);
  expect(headerVal(f.netCalls[0].headers, 'User-Agent')).toBe('mybot/1.0');
  expect(headerVal(f.netCalls[0].headers, 'Referer')).toBe('https://ref.example');
});

test('-w %{http_code} writes the formatted output after the body', async () => {
  const f = fakeIO(['curl', '-w', '%{http_code}\\n', 'https://api.example.com/x'], {
    responder: () => ({ status: 200, headers: [], body: enc.encode('body') }),
  });
  await curlCommand(f.io);
  expect(f.out()).toBe('body200\n');
});

test('-s is silent (no progress/error to stderr) on a connection failure; exit 7', async () => {
  const f = fakeIO(['curl', '-s', 'https://api.example.com/x'], {
    responder: () => Object.assign(new Error('EHOSTUNREACH'), { errno: 'EHOSTUNREACH' }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(7);
  expect(f.err()).toBe('');
});

test('a connection failure without -s reports an error on stderr; exit 7', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/x'], {
    responder: () => Object.assign(new Error('connection refused'), { errno: 'EHOSTUNREACH' }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(7);
  expect(f.err()).not.toBe('');
});

test('a permission-denied (EACCES) net/fetch surfaces as a curl error', async () => {
  const f = fakeIO(['curl', 'https://blocked.example.com/x'], {
    responder: () => Object.assign(new Error('Permission denied'), { errno: 'EACCES' }),
  });
  const code = await curlCommand(f.io);
  expect(code).not.toBe(0);
  expect(f.err()).not.toBe('');
});

// ── exit-code mapping (align with real curl) ───────────────────────────────────

test('couldn\'t-resolve-host (ENOTFOUND) maps to exit 6', async () => {
  const f = fakeIO(['curl', 'https://nope.invalid/x'], {
    responder: () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
  });
  expect(await curlCommand(f.io)).toBe(6);
});

test('couldn\'t-connect (ECONNREFUSED) maps to exit 7', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/x'], {
    responder: () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
  expect(await curlCommand(f.io)).toBe(7);
});

test('operation timeout (ETIMEDOUT) maps to exit 28', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/x'], {
    responder: () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
  });
  expect(await curlCommand(f.io)).toBe(28);
});

test('too-many-redirects (ELOOP) maps to exit 47', async () => {
  const f = fakeIO(['curl', '-L', 'https://api.example.com/x'], {
    responder: () => Object.assign(new Error('too many redirects'), { code: 'ELOOP' }),
  });
  expect(await curlCommand(f.io)).toBe(47);
});

test('-L hitting curl\'s own redirect cap (no kernel follow) exits 47', async () => {
  // The kernel did NOT follow (returns the 3xx each time) and the loop exceeds
  // curl's own MAX_REDIRECTS — curl must report too-many-redirects (exit 47).
  const f = fakeIO(['curl', '-L', 'https://api.example.com/loop'], {
    responder: () => ({ status: 302, headers: [['location', 'https://api.example.com/loop']], body: undefined }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(47);
  expect(f.err()).not.toBe('');
});

// ── -v / --verbose ─────────────────────────────────────────────────────────────

test('-v traces the request and response to stderr', async () => {
  const f = fakeIO(['curl', '-v', 'https://api.example.com/data'], {
    responder: () => ({ status: 200, headers: [['content-type', 'text/plain']], body: enc.encode('hi') }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.out()).toBe('hi');
  const e = f.err();
  // Request line + outgoing header markers, then response status + headers.
  expect(e).toContain('> GET /data');
  expect(e).toContain('* Connected to api.example.com');
  expect(e).toContain('< HTTP/1.1 200');
  expect(e).toContain('< content-type: text/plain');
});

test('-v does NOT pollute stdout (body still clean)', async () => {
  const f = fakeIO(['curl', '-v', 'https://api.example.com/data'], {
    responder: () => ({ status: 200, headers: [], body: enc.encode('clean-body') }),
  });
  await curlCommand(f.io);
  expect(f.out()).toBe('clean-body');
});

test('--verbose is the long form of -v', async () => {
  const f = fakeIO(['curl', '--verbose', 'https://api.example.com/x'], {
    responder: () => ({ status: 204, headers: [], body: undefined }),
  });
  await curlCommand(f.io);
  expect(f.err()).toContain('< HTTP/1.1 204');
});

test('-L follows a 302 redirect to the Location header', async () => {
  let n = 0;
  const f = fakeIO(['curl', '-L', 'https://api.example.com/start'], {
    responder: () => {
      n++;
      if (n === 1) return { status: 302, headers: [['location', 'https://api.example.com/final']], body: undefined };
      return { status: 200, headers: [], body: enc.encode('final body') };
    },
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.netCalls).toHaveLength(2);
  expect(f.netCalls[1].url).toBe('https://api.example.com/final');
  expect(f.out()).toBe('final body');
});

test('without -L a 302 is not followed (body of the redirect response is printed)', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/start'], {
    responder: () => ({ status: 302, headers: [['location', 'https://api.example.com/final']], body: enc.encode('redirect') }),
  });
  await curlCommand(f.io);
  expect(f.netCalls).toHaveLength(1);
  expect(f.out()).toBe('redirect');
});

// ── CU1: 307/308 must PRESERVE method + body; 301/302/303 downgrade to GET ──────

test('CU1: -L on a 307 preserves the POST method and body', async () => {
  let n = 0;
  const f = fakeIO(['curl', '-L', '-X', 'POST', '-d', 'name=mithic', 'https://api.example.com/start'], {
    responder: () => {
      n++;
      if (n === 1) return { status: 307, headers: [['location', 'https://api.example.com/final']], body: undefined };
      return { status: 200, headers: [], body: enc.encode('ok') };
    },
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.netCalls).toHaveLength(2);
  expect(f.netCalls[1].url).toBe('https://api.example.com/final');
  expect(f.netCalls[1].method).toBe('POST');
  expect(new TextDecoder().decode(f.netCalls[1].body)).toBe('name=mithic');
  expect(f.out()).toBe('ok');
});

test('CU1: -L on a 308 preserves the PUT method and body', async () => {
  let n = 0;
  const f = fakeIO(['curl', '-L', '-X', 'PUT', '-d', 'a=1', 'https://api.example.com/start'], {
    responder: () => {
      n++;
      if (n === 1) return { status: 308, headers: [['location', 'https://api.example.com/final']], body: undefined };
      return { status: 200, headers: [], body: enc.encode('done') };
    },
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.netCalls[1].method).toBe('PUT');
  expect(new TextDecoder().decode(f.netCalls[1].body)).toBe('a=1');
});

test('CU1: -L on a 303 downgrades a POST to GET and drops the body', async () => {
  let n = 0;
  const f = fakeIO(['curl', '-L', '-X', 'POST', '-d', 'a=1', 'https://api.example.com/start'], {
    responder: () => {
      n++;
      if (n === 1) return { status: 303, headers: [['location', 'https://api.example.com/final']], body: undefined };
      return { status: 200, headers: [], body: enc.encode('done') };
    },
  });
  await curlCommand(f.io);
  expect(f.netCalls[1].method).toBe('GET');
  expect(f.netCalls[1].body).toBeUndefined();
});

test('CU1: -L on a 301 downgrades a POST to GET and drops the body', async () => {
  let n = 0;
  const f = fakeIO(['curl', '-L', '-X', 'POST', '-d', 'a=1', 'https://api.example.com/start'], {
    responder: () => {
      n++;
      if (n === 1) return { status: 301, headers: [['location', 'https://api.example.com/final']], body: undefined };
      return { status: 200, headers: [], body: enc.encode('done') };
    },
  });
  await curlCommand(f.io);
  expect(f.netCalls[1].method).toBe('GET');
  expect(f.netCalls[1].body).toBeUndefined();
});

test('reads POST body from stdin when -d @- is given', async () => {
  const f = fakeIO(['curl', '-d', '@-', 'https://api.example.com/p'], { stdin: 'from stdin' });
  await curlCommand(f.io);
  expect(f.netCalls[0].method).toBe('POST');
  expect(new TextDecoder().decode(f.netCalls[0].body)).toBe('from stdin');
});

test('no URL operand is an error (exit non-zero)', async () => {
  const f = fakeIO(['curl']);
  const code = await curlCommand(f.io);
  expect(code).not.toBe(0);
  expect(f.err()).not.toBe('');
});

test('multiple URLs are each fetched and their bodies concatenated', async () => {
  const f = fakeIO(['curl', 'https://api.example.com/a', 'https://api.example.com/b'], {
    responder: (c) => ({ status: 200, headers: [], body: enc.encode(c.url.endsWith('/a') ? 'AAA' : 'BBB') }),
  });
  const code = await curlCommand(f.io);
  expect(code).toBe(0);
  expect(f.netCalls).toHaveLength(2);
  expect(f.out()).toBe('AAABBB');
});
