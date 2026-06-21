/**
 * B2/B6 — a capability-scoped standard `fetch()` façade over the `net/fetch`
 * syscall, with a STREAMING `Response.body`.
 *
 * ARCHITECTURAL INVARIANT: the wire format is unchanged. `net/fetch` still takes
 * `{method, url, headers, body, timeoutMs?}`. This module is a pure ADAPTER
 * (Dependency Inversion): guest code depends on the standard WHATWG
 * `fetch`/`Request`/`Response` interfaces, and the adapter depends on the
 * injected syscall port. The integer-free arg-bag stays an internal detail.
 *
 * BODY DELIVERY (B6): the kernel returns one of two shapes —
 *   - TRANSFERABLE backend: `{status, headers, bodyStream: true}` PLUS a
 *     transferred read MessagePort. `Response.body` is a live `ReadableStream`
 *     over that port (via {@link portToReadable}) — a large download never
 *     buffers wholesale, and cancelling the body (or aborting `init.signal`)
 *     propagates EPIPE back so the in-flight transport stops.
 *   - NON-TRANSFERABLE (relay/QuickJS) backend: `{status, headers, body?}` with
 *     the materialized bytes inline (no port). `Response.body` wraps those bytes.
 * `res.text()`/`.arrayBuffer()`/`.json()` consume whichever stream they get.
 */
import type { SyscallCallOptions, SyscallResult } from './syscall-client.ts';
import { portToReadable } from './streams.ts';

/**
 * The plain syscall hook — the `Guest.syscall` shape, returning only the decoded
 * result (no ports). Shared by the `fs/*` façade (`fs-access.ts`) which never
 * needs transferred ports. A guest passes `guest.syscall`; a command passes
 * `io.syscall`.
 */
export type SyscallHook = (
  call: string,
  args: Record<string, unknown>,
  opts?: SyscallCallOptions,
) => Promise<unknown>;

/**
 * B6: the PORTS-AWARE syscall hook the fetch façade depends on — the
 * `Guest.syscallPorts` shape, returning both the decoded result and any
 * MessagePorts the kernel transferred (the streaming body's read end).
 */
export type PortsSyscallHook = (
  call: string,
  args: Record<string, unknown>,
  opts?: SyscallCallOptions,
) => Promise<SyscallResult>;

/** The shape `net/fetch` returns on the wire. */
interface NetFetchResult {
  status: number;
  statusText?: string;
  headers?: [string, string][];
  /** Buffered fallback body (relay backends). */
  body?: Uint8Array | ArrayBuffer;
  /** B6: true when the body is delivered as a STREAM over a transferred port. */
  bodyStream?: boolean;
}

/**
 * Build a standard `fetch(input, init): Promise<Response>` bound to a ports-aware
 * syscall hook. `input` is a URL string or a `Request`; `init` is the standard
 * `RequestInit` (we honour `method`, `headers`, `body`, and `signal`).
 *
 * `init.signal` (an `AbortSignal`) is threaded straight through to the syscall
 * via {@link SyscallCallOptions.signal} (Stage-1 B1), so a guest can cancel or
 * time-bound a request; for a STREAMED body the same signal also cancels the
 * in-flight body stream (B6). A rejection carrying `code:'ECANCELED'`/
 * `'ETIMEDOUT'` is surfaced as a DOM `AbortError`/`TimeoutError`.
 */
export function createFetch(syscall: PortsSyscallHook): typeof fetch {
  return async function mithicFetch(
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Normalize (input, init) → a single Request so header/method/body merging
    // follows the standard precedence rules for free.
    const request = new Request(input as RequestInfo, init);

    const signal = request.signal;
    // Already-aborted: reject before sending, like the platform fetch.
    if (signal.aborted) throw abortError(signal);

    const headers: [string, string][] = [];
    request.headers.forEach((value, key) => { headers.push([key, value]); });

    const args: Record<string, unknown> = {
      method: request.method,
      url: request.url,
      headers,
    };

    // Materialize the request body to bytes (a single Uint8Array). A bodyless
    // request (GET/HEAD) sends no `body` field — the kernel treats it as none.
    if (request.body !== null || hasInitBody(init)) {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 0 || hasInitBody(init)) {
        args.body = new Uint8Array(buf);
      }
    }

    const opts: SyscallCallOptions = {};
    // Thread the AbortSignal through to the syscall (B1). The platform exposes a
    // request signal even when none was supplied; only forward a live one.
    opts.signal = signal;

    let settled: SyscallResult;
    try {
      settled = await syscall('net/fetch', args, opts);
    } catch (e) {
      // Surface cancellation/timeout as the standard DOM exceptions a fetch
      // caller expects, so `try { await fetch() } catch (e) { e.name }` works.
      const code = errnoOf(e);
      if (code === 'ECANCELED') throw abortError(signal, e);
      if (code === 'ETIMEDOUT') throw new DOMException(messageOf(e), 'TimeoutError');
      throw e;
    }

    const result = settled.result as NetFetchResult;
    const ports = settled.ports ?? [];
    return buildResponse(result, ports, signal);
  } as typeof fetch;
}

/**
 * Build a standard `Response` from the `net/fetch` wire result. The body is:
 *   - a live `ReadableStream` over the transferred read port when the kernel
 *     streamed it (`bodyStream: true` + a port arrived); aborting `signal`
 *     cancels the stream;
 *   - the inline buffered bytes otherwise (relay backends);
 *   - `null` for a status that forbids a body (204/205/304 — the `Response`
 *     constructor throws otherwise).
 */
function buildResponse(result: NetFetchResult, ports: readonly MessagePort[], signal: AbortSignal): Response {
  const status = result.status;
  const headers = new Headers(result.headers ?? []);
  const init: ResponseInit = { status, headers };
  if (typeof result.statusText === 'string') init.statusText = result.statusText;

  if (nullBodyStatus(status)) {
    // A streamed body for a null-body status should not happen, but if a port
    // arrived, release it so it does not leak.
    for (const p of ports) { try { p.close(); } catch { /* neutered */ } }
    return new Response(null, init);
  }

  if (result.bodyStream && ports[0]) {
    // B6: a live ReadableStream over the transferred read port. Passing the
    // request signal wires abort → tear the stream down: it errors the
    // controller (unblocking a pending read) AND posts EPIPE up the port so the
    // kernel net/fetch pump latches broken and aborts the in-flight transport.
    const stream = portToReadable(ports[0], signal);
    return new Response(stream, init);
  }

  // Buffered fallback (relay backend) — or a streamed result that arrived with
  // no port (defensive: treat as empty).
  const body = result.body ?? new Uint8Array();
  return new Response(body as BodyInit, init);
}

/** Statuses for which a `Response` body MUST be null (per the Fetch spec). */
function nullBodyStatus(status: number): boolean {
  return status === 101 || status === 103 || status === 204 || status === 205 || status === 304;
}

/** Whether the caller supplied a request body in `init` (so an empty one is still sent). */
function hasInitBody(init: RequestInit | undefined): boolean {
  return init !== undefined && init.body !== undefined && init.body !== null;
}

/** Build an `AbortError` DOMException, preferring the signal's own abort reason. */
function abortError(signal: AbortSignal, cause?: unknown): DOMException {
  const reason = signal.reason;
  if (reason instanceof DOMException) return reason;
  if (reason instanceof Error) return new DOMException(reason.message, 'AbortError');
  return new DOMException(cause instanceof Error ? cause.message : 'The operation was aborted.', 'AbortError');
}

function errnoOf(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
