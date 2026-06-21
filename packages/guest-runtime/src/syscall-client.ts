import { isSyscallResponse } from '@mithic/protocol';
import type { Transport } from './transport.ts';

export interface SyscallClientOptions {
  /**
   * Optional per-call wall-clock timeout in milliseconds. When set, any
   * syscall that receives no response within `timeoutMs` ms is rejected with
   * an error carrying `code: 'ETIMEDOUT'`. Default: undefined (no timeout —
   * preserves the original behaviour so existing tests are unaffected).
   */
  timeoutMs?: number;
}

/**
 * B1: per-call options for {@link SyscallClient.syscall}. A guest can pass a
 * cancellation `signal` and/or a `timeoutMs` to a single call. When either
 * fires, the in-flight syscall settles with `code: 'ETIMEDOUT'` (a timeout) or
 * `code: 'ECANCELED'` (a caller abort) instead of hanging. For `net/fetch` this
 * is the cancellation primitive that, paired with the transport-level
 * enforcement in FetchHttpClient, lets a guest bound or cancel a request.
 */
export interface SyscallCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * B5: the full settled value of a syscall — the decoded `result` plus any
 * MessagePorts the kernel transferred with the response (e.g. the read/write
 * ends of an `fs/pipe`, or the connection port of an `ipc/connect`). For calls
 * that carry no ports, `ports` is an empty array.
 */
export interface SyscallResult {
  result: unknown;
  ports: readonly MessagePort[];
}

interface PendingCall {
  resolve: (v: SyscallResult) => void;
  reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class SyscallClient {
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private transport: Transport;
  private timeoutMs: number | undefined;

  constructor(transport: Transport, options: SyscallClientOptions = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs;
    transport.onMessage((msg, ports) => {
      if (!isSyscallResponse(msg)) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.#settle(msg.id, p);
      if (msg.ok) {
        // B5: surface any transferred ports alongside the result.
        p.resolve({ result: msg.result, ports: ports ?? [] });
      } else {
        const err = Object.assign(new Error(msg.error.message), { code: msg.error.code });
        p.reject(err);
      }
    });
  }

  /** Remove a pending call and tear down its timer + abort listener. */
  #settle(id: number, p: PendingCall): void {
    this.pending.delete(id);
    if (p.timer !== undefined) clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
  }

  /**
   * Issue a syscall, returning ONLY the decoded result (the historical shape).
   * Any transferred ports are dropped. Use {@link syscallPorts} when the call
   * mints ports (e.g. `fs/pipe`, `ipc/connect`, `ipc/accept`).
   */
  syscall(call: string, args: Record<string, unknown>, opts: SyscallCallOptions = {}): Promise<unknown> {
    return this.#dispatch(call, args, opts).then((r) => r.result);
  }

  /**
   * B5: issue a syscall and return BOTH the decoded result and any MessagePorts
   * the kernel transferred with the response. For `fs/pipe` this yields the
   * `[readPort, writePort]`; for `ipc/connect`/`ipc/accept` the single duplex
   * port. Calls that carry no ports resolve with `ports: []`.
   */
  syscallPorts(call: string, args: Record<string, unknown>, opts: SyscallCallOptions = {}): Promise<SyscallResult> {
    return this.#dispatch(call, args, opts);
  }

  #dispatch(call: string, args: Record<string, unknown>, opts: SyscallCallOptions): Promise<SyscallResult> {
    const id = this.nextId++;
    // Per-call timeout takes precedence over the client-wide default.
    const effectiveTimeout = opts.timeoutMs ?? this.timeoutMs;
    return new Promise<SyscallResult>((resolve, reject) => {
      // Already-aborted signal: reject synchronously without ever sending.
      if (opts.signal?.aborted) {
        reject(Object.assign(new Error(`syscall canceled: ${call}`), { code: 'ECANCELED' }));
        return;
      }
      const entry: PendingCall = { resolve, reject, signal: opts.signal };
      if (effectiveTimeout !== undefined) {
        entry.timer = setTimeout(() => {
          const p = this.pending.get(id);
          if (p) {
            this.#settle(id, p);
            reject(Object.assign(new Error(`syscall timed out: ${call}`), { code: 'ETIMEDOUT' }));
          }
        }, effectiveTimeout);
      }
      if (opts.signal) {
        entry.onAbort = () => {
          const p = this.pending.get(id);
          if (p) {
            this.#settle(id, p);
            reject(Object.assign(new Error(`syscall canceled: ${call}`), { code: 'ECANCELED' }));
          }
        };
        opts.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      this.transport.send({ id, call, args });
    });
  }

  /** Rejects all in-flight syscalls and closes the underlying transport. */
  close(): void {
    const err = Object.assign(new Error('transport closed'), { code: 'EPIPE' });
    for (const p of this.pending.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
      p.reject(err);
    }
    this.pending.clear();
    this.transport.close();
  }
}
