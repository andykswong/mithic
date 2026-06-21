/**
 * `curl` — a curl-like HTTP client that runs as a sandboxed Mithic process.
 *
 * THE TEMPLATE for a `@mithic/curl` command (currently the only one). The file:
 *   1. imports the harness helpers it needs,
 *   2. defines a pure {@link import('./harness.ts').CommandFn} (`(io) => exitCode`),
 *   3. `export default defineCommand(curlCommand);` to become a guest module.
 *
 * The repo's vite `preserveModules` build emits this 1:1 as `dist/curl.js`,
 * which {@link import('./resolver.ts').createCurlResolver} hands to the kernel by
 * URL. The kernel launches it as a sandboxed process; `createGuest` (inside
 * `defineCommand`) wires stdio and the syscall hook.
 *
 * NETWORK: every request goes through the single `net/fetch` syscall. The kernel
 * capability-gates it by ORIGIN against the process's `net` capability — an
 * ungranted origin is rejected with EACCES BEFORE any request is made. curl
 * never holds a socket or `fetch`; the sandbox boundary is the kernel.
 *
 * Supported flags (practical subset):
 *   URL(s) as operands; default GET, body → stdout.
 *   -X METHOD, -H 'H: v' (repeatable), -d/--data DATA (implies POST),
 *   --data-raw, -G (data as query), -o FILE / -O, -s (silent), -S (show-error),
 *   -i (include headers), -I/--head (HEAD), -L (follow redirects),
 *   -f (fail on HTTP >= 400 → exit 22), -w FORMAT (%{http_code} etc.),
 *   -u user:pass (basic auth), --json, -A user-agent, -e referer,
 *   -v/--verbose (request/response trace to stderr),
 *   --max-time SECONDS, -k (insecure — no-op under fetch).
 * Exit codes (aligned with real curl): 0 ok, 2 usage, 3 malformed-url,
 *   6 couldn't-resolve-host, 7 couldn't-connect, 22 http-error (with -f),
 *   28 operation-timeout, 47 too-many-redirects.
 */
import { defineCommand, parseArgs, readAll, writeLine, writeString } from './harness.ts';
import type { CommandFn, CommandIO } from './harness.ts';

/**
 * curl's internal response METADATA — status/headers only, NOT the body. B6: the
 * body stays a live {@link Response} (`res.body` is a `ReadableStream`) that the
 * main loop pumps straight to its destination (a VFS file or stdout) WITHOUT
 * buffering it whole — so `curl big -o file` streams to disk and `curl big | head`
 * lets the consumer cancel early. The redirect loop, header formatting, and `-w`
 * logic consume this metadata; the body byte count (`-w %{size_download}`) is
 * tracked during the pump.
 */
interface FetchResult {
  status: number;
  statusText?: string;
  headers: [string, string][];
  /** The live response whose `body` stream is pumped to the destination. */
  response: Response;
  /** Bytes actually downloaded (filled in after the body is pumped). */
  downloaded?: number;
}

/** curl exit codes used here (subset of the real curl table). */
const EXIT = {
  OK: 0,
  USAGE: 2,
  MALFORMED_URL: 3,
  COULDNT_RESOLVE_HOST: 6,
  COULDNT_CONNECT: 7,
  HTTP_RETURNED_ERROR: 22,
  OPERATION_TIMEDOUT: 28,
  TOO_MANY_REDIRECTS: 47,
} as const;

const MAX_REDIRECTS = 50;

export const curlCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'curl';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['s', 'S', 'i', 'I', 'head', 'L', 'f', 'G', 'O', 'k', 'insecure', 'silent', 'fail', 'v', 'verbose'],
    string: ['X', 'request', 'o', 'output', 'w', 'write-out', 'u', 'user', 'A', 'user-agent', 'e', 'referer', 'json', 'max-time'],
    collect: ['H', 'header', 'd', 'data', 'data-raw'],
    alias: {
      request: 'X',
      header: 'H',
      data: 'd',
      'data-raw': 'd',
      output: 'o',
      'write-out': 'w',
      user: 'u',
      'user-agent': 'A',
      referer: 'e',
      head: 'I',
      silent: 's',
      fail: 'f',
      insecure: 'k',
      verbose: 'v',
    },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  const silent = Boolean(flags.s);
  const showError = Boolean(flags.S);
  const includeHeaders = Boolean(flags.i);
  const headOnly = Boolean(flags.I);
  const followRedirects = Boolean(flags.L);
  const verbose = Boolean(flags.v);
  const failOnError = Boolean(flags.f);
  const dataAsQuery = Boolean(flags.G);
  const writeToFileNamed = typeof flags.o === 'string' ? flags.o : undefined;
  const writeToRemoteName = Boolean(flags.O);
  const writeOut = typeof flags.w === 'string' ? unescapeFormat(flags.w) : undefined;

  /** Report an error to stderr unless silenced. -s suppresses; -sS re-enables. */
  const reportError = async (msg: string): Promise<void> => {
    if (silent && !showError) return;
    await writeLine(err, `${name}: ${msg}`);
  };

  /** Emit a `-v` trace line to stderr (no-op unless verbose). */
  const trace = async (line: string): Promise<void> => {
    if (!verbose) return;
    await writeLine(err, line);
  };

  try {
    const urls = positionals;
    if (urls.length === 0) {
      await reportError('no URL specified');
      return EXIT.USAGE;
    }

    // Build the shared request method / headers / body from the flags.
    const headers: [string, string][] = [];
    let method = typeof flags.X === 'string' && flags.X !== '' ? flags.X : 'GET';

    // -d / --data / --data-raw (repeatable). Multiple data items join with '&'.
    const dataItems = toArray(flags.d);
    const jsonBody = typeof flags.json === 'string' ? flags.json : undefined;
    let body: Uint8Array | undefined;
    let queryData: string | undefined;

    if (jsonBody !== undefined) {
      addHeaderIfAbsent(headers, 'Content-Type', 'application/json');
      addHeaderIfAbsent(headers, 'Accept', 'application/json');
      body = new TextEncoder().encode(jsonBody);
      if (flags.X === undefined) method = 'POST';
    } else if (dataItems.length > 0) {
      // `@-` reads the body from stdin; `@file` would read a file (not supported
      // — treated as literal). Otherwise the data is sent literally.
      const resolved: string[] = [];
      for (const item of dataItems) {
        if (item === '@-') {
          resolved.push(new TextDecoder().decode(await readAll(io.stdin)));
        } else {
          resolved.push(item);
        }
      }
      const dataStr = resolved.join('&');
      if (dataAsQuery) {
        // -G: append data to the URL query string, keep the method (GET).
        queryData = dataStr;
      } else {
        addHeaderIfAbsent(headers, 'Content-Type', 'application/x-www-form-urlencoded');
        body = new TextEncoder().encode(dataStr);
        if (flags.X === undefined) method = 'POST';
      }
    }

    if (headOnly) method = 'HEAD';

    // -u user:pass → Basic auth.
    if (typeof flags.u === 'string' && flags.u !== '') {
      addHeaderIfAbsent(headers, 'Authorization', 'Basic ' + base64(flags.u));
    }
    // -A user-agent, -e referer.
    if (typeof flags.A === 'string') addHeaderIfAbsent(headers, 'User-Agent', flags.A);
    if (typeof flags.e === 'string') addHeaderIfAbsent(headers, 'Referer', flags.e);

    // -H custom headers (repeatable). `Name: value`; a bare `Name;` unsets — we
    // keep it simple and only support the `Name: value` form.
    for (const h of toArray(flags.H)) {
      const idx = h.indexOf(':');
      if (idx < 0) continue;
      const k = h.slice(0, idx).trim();
      const v = h.slice(idx + 1).trim();
      if (k) headers.push([k, v]);
    }

    const timeoutMs = typeof flags['max-time'] === 'string' && flags['max-time'] !== ''
      ? Math.round(Number(flags['max-time']) * 1000)
      : undefined;

    let exitCode: number = EXIT.OK;

    for (const rawUrl of urls) {
      const url = applyQuery(rawUrl, queryData);
      const r = await fetchFollowing(io, {
        method, url, headers, body, timeoutMs, followRedirects,
      }, trace);
      if (r instanceof FetchError) {
        await reportError(r.message);
        exitCode = r.exitCode;
        continue;
      }

      // -f: HTTP >= 400 → no body, exit 22 (last error wins). Cancel the body
      // stream so the in-flight transport stops (nothing is downloaded).
      if (failOnError && r.status >= 400) {
        await cancelResponse(r.response);
        await reportError(`The requested URL returned error: ${r.status}`);
        exitCode = EXIT.HTTP_RETURNED_ERROR;
        continue;
      }

      // Header output: -I always; -i prepends to the body.
      const headerText = (headOnly || includeHeaders) ? formatStatusAndHeaders(r) : '';
      if (headerText) await writeString(out, headerText);

      // Body destination: -o FILE, -O remote-name, else stdout. HEAD has no body.
      const target = writeToFileNamed ?? (writeToRemoteName ? remoteName(url) : undefined);

      if (headOnly) {
        // No body for HEAD — discard the stream (the kernel returns none anyway).
        await cancelResponse(r.response);
        r.downloaded = 0;
      } else if (target !== undefined) {
        // -o/-O: STREAM the body to the VFS file (pump res.body → fs writes), so a
        // large download never buffers wholesale.
        r.downloaded = await streamToFile(io, target, r.response);
      } else {
        // stdout: STREAM the body chunk-by-chunk to stdout. If the downstream
        // consumer (`| head -c10`) cancels, `out.write` rejects (broken pipe);
        // we cancel res.body, which aborts the in-flight fetch.
        r.downloaded = await streamToWriter(out, r.response);
      }

      // -w: formatted output to stdout after the transfer.
      if (writeOut) await writeString(out, renderWriteOut(writeOut, r, url));
    }

    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

/** A network/transport failure carrying the curl exit code to surface. */
class FetchError {
  readonly message: string;
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    this.message = message;
    this.exitCode = exitCode;
  }
}

/**
 * Perform `net/fetch`, following 3xx redirects when `followRedirects` is set
 * (up to {@link MAX_REDIRECTS}). Maps a kernel errno to a curl exit code.
 *
 * The kernel's `net/fetch` already follows redirects internally (re-checking the
 * `net` capability against every hop), so curl normally receives the FINAL
 * response in one call. This client-side loop still matters when the kernel
 * hands a 3xx back (e.g. a redirect to an origin curl should re-evaluate) and
 * must apply RFC 7231/7538 method semantics correctly so the two compose:
 *   - 301/302/303 → downgrade to GET and drop the body;
 *   - 307/308     → PRESERVE the original method AND body.
 * Exceeding {@link MAX_REDIRECTS} is curl's too-many-redirects (exit 47).
 */
async function fetchFollowing(
  io: CommandIO,
  req: { method: string; url: string; headers: [string, string][]; body?: Uint8Array; timeoutMs?: number; followRedirects: boolean },
  trace: (line: string) => Promise<void>,
): Promise<FetchResult | FetchError> {
  let url = req.url;
  let method = req.method;
  let body = req.body;
  for (let hop = 0; ; hop++) {
    await traceRequest(trace, method, url, req.headers, body);
    let result: FetchResult;
    try {
      // B2: go through the standard `fetch()` façade. `--max-time` becomes an
      // `AbortSignal.timeout(ms)` (threaded to the syscall via B1). B6: the
      // standard `Response` is kept LIVE — its `body` stream is pumped to the
      // destination later, never buffered here.
      const init: RequestInit = { method, headers: req.headers };
      if (body) init.body = body as BodyInit;
      if (req.timeoutMs !== undefined) init.signal = AbortSignal.timeout(req.timeoutMs);
      const res = await io.fetch(url, init);
      result = metaOf(res);
    } catch (e) {
      return new FetchError(messageOf(e), errnoToExit(errnoOf(e)));
    }
    await traceResponse(trace, result);
    if (req.followRedirects && isRedirect(result.status)) {
      const loc = headerValue(result.headers, 'location');
      if (loc) {
        // The intermediate redirect body is discarded — cancel it so the
        // transport stops (an undrained stream would leak/stall).
        await cancelResponse(result.response);
        if (hop >= MAX_REDIRECTS) {
          return new FetchError(`Maximum (${MAX_REDIRECTS}) redirects followed`, EXIT.TOO_MANY_REDIRECTS);
        }
        url = resolveUrl(url, loc);
        // RFC 7231/7538: 301/302/303 turn the request into a bodyless GET; but
        // 307/308 MUST preserve the original method and body (e.g. a POST stays
        // a POST). Dropping the body on 307/308 would silently corrupt the
        // request, so we only downgrade for 301/302/303.
        if (!preservesMethod(result.status)) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
    }
    return result;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** True for redirects that preserve the request method + body (307, 308). */
function preservesMethod(status: number): boolean {
  return status === 307 || status === 308;
}

/** Map a kernel errno (from the net/fetch rejection) to a curl exit code. */
function errnoToExit(errno: string | undefined): number {
  switch (errno) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      // DNS could not resolve the host.
      return EXIT.COULDNT_RESOLVE_HOST;
    case 'EHOSTUNREACH':
    case 'ECONNREFUSED':
    case 'ENETUNREACH':
    case 'ECONNRESET':
    case 'EPIPE':
      return EXIT.COULDNT_CONNECT;
    case 'ETIMEDOUT':
      return EXIT.OPERATION_TIMEDOUT;
    case 'ELOOP':
      // The kernel hit its own redirect cap (SSRF-safe redirect follow).
      return EXIT.TOO_MANY_REDIRECTS;
    case 'EACCES':
    case 'EPERM':
      // A capability denial: not a normal curl code, but must be non-zero.
      return EXIT.COULDNT_CONNECT;
    default:
      return EXIT.COULDNT_CONNECT;
  }
}

/** Emit the `-v` request trace: `* Connected to host`, `> METHOD path`, `> header`. */
async function traceRequest(
  trace: (line: string) => Promise<void>,
  method: string,
  url: string,
  headers: [string, string][],
  body: Uint8Array | undefined,
): Promise<void> {
  let host = url;
  let pathName = url;
  try {
    const u = new URL(url);
    host = u.host;
    pathName = u.pathname + u.search;
  } catch { /* keep the raw url */ }
  await trace(`* Connected to ${host}`);
  await trace(`> ${method} ${pathName} HTTP/1.1`);
  await trace(`> Host: ${host}`);
  for (const [k, v] of headers) await trace(`> ${k}: ${v}`);
  await trace('>');
  if (body && body.byteLength > 0) await trace(`* upload completely sent off: ${body.byteLength} bytes`);
}

/** Emit the `-v` response trace: `< HTTP/1.1 <status>`, `< header`. */
async function traceResponse(trace: (line: string) => Promise<void>, r: FetchResult): Promise<void> {
  await trace(`< HTTP/1.1 ${r.status}`);
  for (const [k, v] of r.headers) await trace(`< ${k}: ${v}`);
  await trace('<');
}

/**
 * Extract curl's metadata (status/headers/statusText) from a standard
 * {@link Response} (from the B2 `fetch()` façade) WITHOUT touching the body. B6:
 * the body stays live in `result.response.body` and is streamed to its
 * destination by the main loop.
 */
function metaOf(res: Response): FetchResult {
  const headers: [string, string][] = [];
  res.headers.forEach((value, key) => { headers.push([key, value]); });
  return { status: res.status, statusText: res.statusText, headers, response: res };
}

/** Discard an unconsumed response body (cancel its stream) so the transport stops. */
async function cancelResponse(res: Response): Promise<void> {
  if (res.body === null || res.bodyUsed) return;
  try { await res.body.cancel(); } catch { /* already cancelled/locked */ }
}

/**
 * B6: stream a response body to a VFS file (pump `res.body` → `fs/write` calls),
 * truncating, WITHOUT buffering the whole body. Returns the byte count written.
 */
async function streamToFile(io: CommandIO, path: string, res: Response): Promise<number> {
  const { fd } = (await io.syscall('fs/open', {
    path,
    oflags: { create: true, write: true, truncate: true },
  })) as { fd: number };
  let total = 0;
  try {
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          let off = 0;
          while (off < value.byteLength) {
            const chunk = value.subarray(off, off + 65536);
            const { written } = (await io.syscall('fs/write', { fd, data: chunk, offset: total })) as { written: number };
            const n = written > 0 ? written : chunk.byteLength;
            off += n;
            total += n;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    // Ensure the file is created/truncated even for an empty body.
    if (total === 0) {
      await io.syscall('fs/write', { fd, data: new Uint8Array(), offset: 0 });
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
  return total;
}

/**
 * B6: stream a response body to a stdout writer chunk-by-chunk. Returns the byte
 * count written. If `writer.write` rejects (the downstream consumer closed its
 * read end — `| head -c10`), cancel `res.body` so the in-flight fetch aborts
 * (broken pipe → early stop) and stop pumping.
 */
async function streamToWriter(writer: WritableStreamDefaultWriter<Uint8Array>, res: Response): Promise<number> {
  if (res.body === null) return 0;
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      try {
        await writer.write(value);
        total += value.byteLength;
      } catch {
        // Broken pipe downstream: cancel the source so the fetch aborts, then stop.
        try { await reader.cancel(); } catch { /* already cancelled */ }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return total;
}

function errnoOf(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; errno?: unknown; name?: unknown };
    if (typeof o.code === 'string') return o.code;
    if (typeof o.errno === 'string') return o.errno;
    // The B2 fetch() façade surfaces cancellation/timeout as DOM exceptions.
    if (o.name === 'TimeoutError') return 'ETIMEDOUT';
    if (o.name === 'AbortError') return 'ETIMEDOUT';
  }
  return undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `HTTP/1.1 <status>\r\n<headers>\r\n\r\n` (\n form for readability). */
function formatStatusAndHeaders(r: FetchResult): string {
  const lines = [`HTTP/1.1 ${r.status}`];
  for (const [k, v] of r.headers) lines.push(`${k}: ${v}`);
  return lines.join('\n') + '\n\n';
}

/** Render a `-w` format string. Supports `%{http_code}`, `%{size_download}`, `%{url_effective}`, `%%`. */
function renderWriteOut(fmt: string, r: FetchResult, url: string): string {
  return fmt.replace(/%(\{[a-z_]+\}|%)/g, (_m, tok: string) => {
    if (tok === '%') return '%';
    switch (tok) {
      case '{http_code}': return String(r.status);
      case '{size_download}': return String(r.downloaded ?? 0);
      case '{url_effective}': return url;
      case '{content_type}': return headerValue(r.headers, 'content-type') ?? '';
      default: return '';
    }
  });
}

/** Turn `\n`/`\t`/`\r` escape sequences in a `-w` format into real characters. */
function unescapeFormat(fmt: string): string {
  return fmt.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
}

function headerValue(headers: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function addHeaderIfAbsent(headers: [string, string][], name: string, value: string): void {
  if (headerValue(headers, name) === undefined) headers.push([name, value]);
}

function toArray(v: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [v];
  return [];
}

/** Append `data` to a URL's query string (for -G). */
function applyQuery(url: string, data: string | undefined): string {
  if (!data) return url;
  return url + (url.includes('?') ? '&' : '?') + data;
}

/** Resolve a (possibly relative) redirect Location against the current URL. */
function resolveUrl(base: string, location: string): string {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

/** The remote filename for -O: the last path segment, defaulting to `index.html`. */
function remoteName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const seg = path.split('/').filter(Boolean).pop();
    return seg && seg.length > 0 ? seg : 'index.html';
  } catch {
    return 'index.html';
  }
}

/** Base64-encode a UTF-8 string (for Basic auth). */
function base64(s: string): string {
  if (typeof btoa === 'function') return btoa(s);
  // Node fallback.
  return Buffer.from(s, 'utf-8').toString('base64');
}

export default defineCommand(curlCommand);
