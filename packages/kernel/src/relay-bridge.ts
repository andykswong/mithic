import type { SyscallResponse } from '@mithic/protocol';
import { PipeReader, PipeWriter } from '@mithic/protocol';
import type { RelayPipeResult } from './syscall-dispatch.ts';

/**
 * Result of routing a guest syscall through the kernel on the relay path.
 * Mirrors the shape of {@link SyscallResponse} minus the request id, which the
 * kernel owns internally.
 */
export type RelaySyscallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/**
 * Routes a guest's raw syscall through the kernel's dispatcher with the correct,
 * kernel-owned pid. Returns the wire {@link SyscallResponse} plus any transferred
 * ports the dispatcher minted (e.g. the two ends of an `fs/pipe`).
 */
export type RelayDispatch = (
  pid: number,
  call: string,
  args: Record<string, unknown>,
) => Promise<{ response: SyscallResponse; transfer?: Transferable[] }>;

/**
 * C3/K5 — kernel-side byte-relay for `fs/pipe` + connected IPC on non-transferable
 * (relay) backends (§4.8). QuickJS guests cannot receive transferable MessagePorts,
 * so the ports a port-minting syscall produces are retained HERE keyed by the fd
 * NUMBER returned to the guest, and the guest drives them by fd via the first-class
 * `pipe/read`/`pipe/write`/`pipe/close` syscalls — a kernel byte-relay.
 *
 * This was the `Kernel`'s `#relayFds` table + `#relay*` methods + the {@link RelayEnd}
 * class; lifted into a focused collaborator. The Kernel composes it: it routes a
 * relay guest's syscall through {@link relaySyscall} (which dispatches via the
 * injected {@link RelayDispatch} and registers any minted ports here) and injects
 * {@link pipeRead}/{@link pipeWrite}/{@link pipeClose} into the dispatcher's
 * `relayPipe` config. Per-pid teardown runs in {@link closeFds} on process exit.
 *
 * SECURITY: the bridge never holds the raw Kernel or a pid it can forge — the
 * Kernel binds the correct, kernel-owned pid before calling in, so capability
 * enforcement still runs in-kernel identically to the transfer path.
 */
export class RelayBridge {
  #dispatch: RelayDispatch;
  /**
   * Per-pid kernel-held relay pipe ends, keyed by the fd NUMBER the guest was
   * given. On non-transferable backends the guest cannot hold a MessagePort, so
   * `fs/pipe`/`ipc/accept`/`ipc/connect` keep their minted ports HERE and the
   * guest operates them by fd. Cleared per-pid on process exit.
   */
  #relayFds = new Map<number, Map<number, RelayEnd>>();

  constructor(dispatch: RelayDispatch) {
    this.#dispatch = dispatch;
  }

  /**
   * Kernel-owned syscall routing for the relay path. The launcher passes the
   * guest's raw `call`+`args`; this dispatches through the kernel's own
   * `SyscallDispatcher` (via the injected {@link RelayDispatch}) so all capability
   * checks run in-kernel — identical to the transfer path. The launcher can
   * neither forge the pid nor reach the dispatcher directly.
   *
   * K5: syscalls that mint transferable ports (`fs/pipe`, `ipc/accept`,
   * `ipc/connect`) are BYTE-RELAYED instead of ENOSYS'd: the ports are retained
   * keyed by the returned fd numbers and the guest drives them with
   * `pipe/read`/`pipe/write`/`pipe/close`. Any OTHER transferable result (none
   * exist today) closes the ports + ENOSYSs.
   */
  async relaySyscall(
    pid: number,
    call: string,
    args: Record<string, unknown>,
  ): Promise<RelaySyscallResult> {
    const { response, transfer } = await this.#dispatch(pid, call, args);

    if (transfer && transfer.length > 0) {
      // K5: register the minted ports as kernel-held relay fds keyed by the fd
      // numbers in the response, then strip the ports from what crosses the
      // bridge. fs/pipe → {readfd, writefd}; ipc/accept|connect → {connfd}.
      const registered = this.#registerRelayPorts(pid, response, transfer);
      if (registered) {
        return response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error };
      }
      // Unknown transferable result: close to avoid a leak and surface ENOSYS.
      for (const t of transfer) { if (t instanceof MessagePort) t.close(); }
      return { ok: false, error: { code: 'ENOSYS', message: `${call} unsupported on non-transferable backend` } };
    }
    return response.ok
      ? { ok: true, result: response.result }
      : { ok: false, error: response.error };
  }

  /** K5/C2: `pipe/read {fd, len}` over a kernel-held relay end. */
  pipeRead = async (pid: number, fd: number, len?: number): Promise<RelayPipeResult> => {
    const end = this.#relayFds.get(pid)?.get(fd);
    if (!end) return { ok: false, error: { code: 'EBADF', message: `pipe/read: bad fd ${fd}` } };
    const chunk = await end.read(len);
    // Return a plain number array so the value JSON-clones cleanly across the
    // relay bridge (Uint8Array does not survive QuickJS's JSON round-trip).
    return { ok: true, result: { data: Array.from(chunk) } };
  };

  /** K5/C2: `pipe/write {fd, data}` over a kernel-held relay end. */
  pipeWrite = async (pid: number, fd: number, raw: Uint8Array | number[] | string): Promise<RelayPipeResult> => {
    const end = this.#relayFds.get(pid)?.get(fd);
    if (!end) return { ok: false, error: { code: 'EBADF', message: `pipe/write: bad fd ${fd}` } };
    const chunk = raw instanceof Uint8Array ? raw
      : Array.isArray(raw) ? new Uint8Array(raw)
        : new TextEncoder().encode(raw);
    await end.write(chunk);
    return { ok: true, result: { written: chunk.byteLength } };
  };

  /** K5/C2: `pipe/close {fd}` — send EOF + close a kernel-held relay end. */
  pipeClose = (pid: number, fd: number): RelayPipeResult => {
    const table = this.#relayFds.get(pid);
    const end = table?.get(fd);
    if (!table || !end) return { ok: false, error: { code: 'EBADF', message: `pipe/close: bad fd ${fd}` } };
    end.close();
    table.delete(fd);
    return { ok: true, result: {} };
  };

  /** K5: tear down all of a pid's relay ends (process exit). */
  closeFds(pid: number): void {
    const table = this.#relayFds.get(pid);
    if (!table) return;
    for (const end of table.values()) { try { end.close(); } catch { /* closed */ } }
    this.#relayFds.delete(pid);
  }

  /** K5: relay-fd table for a pid (created on demand). */
  #relayTableFor(pid: number): Map<number, RelayEnd> {
    let t = this.#relayFds.get(pid);
    if (!t) { t = new Map(); this.#relayFds.set(pid, t); }
    return t;
  }

  /**
   * K5: register the transferable ports of a port-minting syscall as kernel-held
   * relay ends keyed by the response's fd numbers. Returns true if the response
   * shape was recognized (fs/pipe / ipc connection), false otherwise.
   */
  #registerRelayPorts(pid: number, response: SyscallResponse, transfer: Transferable[]): boolean {
    if (!response.ok) return false;
    const result = response.result as Record<string, unknown>;
    const table = this.#relayTableFor(pid);
    if (typeof result.readfd === 'number' && typeof result.writefd === 'number'
      && transfer[0] instanceof MessagePort && transfer[1] instanceof MessagePort) {
      // fs/pipe: transfer = [readPort, writePort].
      table.set(result.readfd, new RelayEnd(transfer[0]));
      table.set(result.writefd, new RelayEnd(transfer[1]));
      return true;
    }
    if (typeof result.connfd === 'number' && transfer[0] instanceof MessagePort) {
      // ipc/accept | ipc/connect: transfer = [connectionPort] (bidirectional).
      table.set(result.connfd, new RelayEnd(transfer[0]));
      return true;
    }
    return false;
  }
}

/**
 * K5: a kernel-held end of a pipe/IPC MessageChannel used to BYTE-RELAY data to a
 * non-transferable (relay) guest. The guest never holds the port — it operates it
 * by fd via `pipe/read`/`pipe/write`/`pipe/close`, which the kernel services
 * through this wrapper.
 *
 * The wrapper handles BOTH directions so a single object backs both unidirectional
 * pipe ends (fs/pipe) and bidirectional IPC connection ports:
 *   - READ side: grants an initial credit window, buffers incoming `{type:'data'}`
 *     chunks, and observes `{type:'end'}`/`{type:'error'}` (EOF). `read(len)`
 *     returns the next buffered bytes (FIFO), or an empty chunk at EOF, parking
 *     until data arrives if the buffer is empty and the peer has not ended.
 *   - WRITE side: tracks `credit` granted by the peer and `write(chunk)` parks
 *     until enough credit is available, then posts `{type:'data'}`.
 */
class RelayEnd {
  #port: MessagePort;
  #buffer: Uint8Array[] = [];
  #ended = false;
  #readWaiters: Array<() => void> = [];
  #closed = false;
  // C1: shared flow-control primitives. The READ side uses the canonical sliding
  // window (1 MiB for relay throughput); the WRITE side uses the shared credit +
  // STICKY broken latch (so a parked relay writer wakes the instant the peer ends
  // / breaks, matching the guest writer's protection).
  #reader = new PipeReader(RELAY_READ_WINDOW);
  #writer = new PipeWriter();

  constructor(port: MessagePort) {
    this.#port = port;
    port.start?.();
    // Open the read window so the peer writer can flow immediately.
    port.postMessage({ type: 'credit', bytes: this.#reader.open() });
    port.onmessage = (e: MessageEvent): void => {
      const msg = e.data as { type?: string; chunk?: Uint8Array; bytes?: number };
      if (msg?.type === 'data' && msg.chunk) {
        this.#buffer.push(msg.chunk);
        // Replenish read credit for what we consumed into our buffer.
        this.#reader.recordArrival(msg.chunk.byteLength);
        const grant = this.#reader.replenish();
        if (grant > 0) { try { this.#port.postMessage({ type: 'credit', bytes: grant }); } catch { /* closed */ } }
        this.#wakeReaders();
      } else if (msg?.type === 'credit') {
        this.#writer.addCredit(msg.bytes ?? 0);
      } else if (msg?.type === 'end' || msg?.type === 'error') {
        this.#ended = true;
        this.#wakeReaders();
        // Latch broken so any parked writer wakes (rejects) on the dead peer.
        this.#writer.markBroken('EPIPE');
      }
    };
  }

  #wakeReaders(): void { for (const w of this.#readWaiters.splice(0)) w(); }

  /** Read up to `len` bytes (or the next buffered chunk). Empty chunk = EOF. */
  async read(len?: number): Promise<Uint8Array> {
    for (;;) {
      if (this.#buffer.length > 0) {
        const head = this.#buffer[0];
        if (len === undefined || len >= head.byteLength) { this.#buffer.shift(); return head; }
        // Partial read: split the head chunk.
        const out = head.subarray(0, len);
        this.#buffer[0] = head.subarray(len);
        return new Uint8Array(out);
      }
      if (this.#ended || this.#closed) return new Uint8Array(0);
      await new Promise<void>((resolve) => this.#readWaiters.push(resolve));
    }
  }

  /**
   * Write `chunk`, parking until the peer grants enough credit. Relay semantics:
   * a broken/ended/closed peer just STOPS the write (resolves) rather than
   * throwing — the relay byte API returns `{written}` regardless.
   */
  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed || chunk.byteLength === 0) return;
    try {
      await this.#writer.reserve(chunk.byteLength);
    } catch {
      // Pipe broken while parked: stop silently (relay write does not throw).
      return;
    }
    if (this.#closed || this.#ended) return;
    try { this.#port.postMessage({ type: 'data', chunk }); } catch { /* closed */ }
  }

  /** Send EOF to the peer and close the port. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#port.postMessage({ type: 'end' }); } catch { /* closed */ }
    try { this.#port.close(); } catch { /* closed */ }
    this.#wakeReaders();
    // Wake any parked writer so it doesn't hang on a now-closed end.
    this.#writer.markBroken('EPIPE');
  }
}

/** K5: initial read-credit window granted to a relay end's peer writer (bytes). */
const RELAY_READ_WINDOW = 1 << 20; // 1 MiB
