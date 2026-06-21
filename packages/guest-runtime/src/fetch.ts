/**
 * B2 — a capability-scoped standard `fetch()` façade over the `net/fetch`
 * syscall.
 *
 * ARCHITECTURAL INVARIANT: the wire format is unchanged. `net/fetch` still takes
 * `{method, url, headers, body, timeoutMs?}` and returns `{status, statusText?,
 * headers, body?}`. This module is a pure ADAPTER (Dependency Inversion): guest
 * code depends on the standard WHATWG `fetch`/`Request`/`Response` interfaces,
 * and the adapter depends on the injected syscall port. The integer-free arg-bag
 * stays an internal detail.
 *
 * SCOPE: the body is the MATERIALIZED bytes returned by `net/fetch`, wrapped in a
 * standard `Response`. The streaming-body (`Response.body` over a transferred
 * port) half is the separate B6 workstream and is intentionally NOT done here.
 */
import type { SyscallCallOptions } from './syscall-client.ts';

/**
 * The syscall hook the façade depends on — exactly the `Guest.syscall` shape, so
 * a guest passes `guest.syscall` and a command passes its `io.syscall`.
 */
export type SyscallHook = (
  call: string,
  args: Record<string, unknown>,
  opts?: SyscallCallOptions,
) => Promise<unknown>;

/** The shape `net/fetch` returns on the wire (materialized body). */
interface NetFetchResult {
  status: number;
  statusText?: string;
  headers?: [string, string][];
  body?: Uint8Array | ArrayBuffer;
}

/**
 * Build a standard `fetch(input, init): Promise<Response>` bound to a syscall
 * hook. `input` is a URL string or a `Request`; `init` is the standard
 * `RequestInit` (we honour `method`, `headers`, `body`, and `signal`).
 *
 * `init.signal` (an `AbortSignal`) is threaded straight through to the syscall
 * via {@link SyscallCallOptions.signal} (Stage-1 B1), so a guest can cancel or
 * time-bound a request. A rejection carrying `code:'ECANCELED'`/`'ETIMEDOUT'` is
 * surfaced as a DOM `AbortError`/`TimeoutError` to match the platform `fetch`.
 */
export function createFetch(syscall: SyscallHook): typeof fetch {
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

    let result: NetFetchResult;
    try {
      result = (await syscall('net/fetch', args, opts)) as NetFetchResult;
    } catch (e) {
      // Surface cancellation/timeout as the standard DOM exceptions a fetch
      // caller expects, so `try { await fetch() } catch (e) { e.name }` works.
      const code = errnoOf(e);
      if (code === 'ECANCELED') throw abortError(signal, e);
      if (code === 'ETIMEDOUT') throw new DOMException(messageOf(e), 'TimeoutError');
      throw e;
    }

    return buildResponse(result);
  } as typeof fetch;
}

/**
 * Build a standard `Response` from the `net/fetch` wire result. A null body is
 * required for 204/205/304 (the `Response` constructor throws otherwise), so a
 * status that forbids a body gets `null`.
 */
function buildResponse(result: NetFetchResult): Response {
  const status = result.status;
  const headers = new Headers(result.headers ?? []);
  const body = nullBodyStatus(status) ? null : (result.body ?? new Uint8Array());
  const init: ResponseInit = { status, headers };
  if (typeof result.statusText === 'string') init.statusText = result.statusText;
  return new Response(body as BodyInit | null, init);
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
